/**
 * OwnerBackfill — discovers historical discrete orders for non-deterministic
 * generators (the realtime poller only ever returns the *current* tradeable
 * order, never past ones). Each firing drains a bounded batch of
 * not-yet-backfilled owners. Ported from the upstream ponder indexer's
 * ownerBackfill.ts.
 *
 * Two registrations share the drain:
 *   - OwnerBackfill (historical): coarse 250-block stride, runs during the
 *     event backfill so the orderbook drain overlaps historical sync.
 *   - OwnerBackfillLive: fine per-chain stride from the tip onward, mops up
 *     owners created late in the backfill and any not finished before the tip.
 *
 * Eligibility is the historyBackfilled flag, set at generator creation for the
 * cases that never need a drain (deterministic types, and generators created
 * live) — see ComposableCoW.ts.
 */

import { indexer } from "envio";
import type { Hex } from "viem";
import {
  BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_OWNERS_BACKFILL_PER_BLOCK,
} from "../constants.js";
import { fetchComposableOrders, upsertDiscreteOrders } from "../helpers/orderbook/client.js";
import { TimeoutError, withTimeout } from "../helpers/withTimeout.js";
import { log } from "../helpers/logger.js";
import { blockHandlerInterval, isTest, resolveCap, pollerActivationFloor } from "../helpers/blockHandlerShared.js";
import { NON_DETERMINISTIC_TYPES } from "../utils/order-types.js";

// Shared drain — registered for both the historical and live block handlers below.
async function drainOwnerBatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  block: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  phase: "historical" | "live",
): Promise<void> {
  const chainId = context.chain.id;
  const currentBlock = BigInt(block.number);
  const cap = resolveCap(
    `MAX_OWNERS_BACKFILL_PER_BLOCK_${chainId}`,
    DEFAULT_MAX_OWNERS_BACKFILL_PER_BLOCK,
  );

  const eligible = await context.ConditionalOrderGenerator.getWhere({
    chainId: { _eq: chainId },
    status: { _eq: "Active" },
    orderType: { _in: [...NON_DETERMINISTIC_TYPES] },
    historyBackfilled: { _eq: false },
  });

  if (eligible.length === 0) return; // nothing pending — cheap no-op

  // Take up to `cap` distinct owners this block; ordering by owner keeps
  // progress deterministic and lets already-drained owners fall out of the set.
  const owners = [...new Set(eligible.map((g: { owner: string }) => g.owner))]
    .sort()
    .slice(0, cap) as Hex[];

  // Generator ids for the selected owners, to flip historyBackfilled after a clean drain.
  const ownerGeneratorIds = new Map<string, string[]>();
  for (const g of eligible) {
    if (!owners.includes(g.owner as Hex)) continue;
    const existing = ownerGeneratorIds.get(g.owner) ?? [];
    existing.push(g.id);
    ownerGeneratorIds.set(g.owner, existing);
  }

  if (!context.isPreload) {
    log("info", "OwnerBackfill:START", { block: String(currentBlock), chainId, phase, owners: owners.length, cap });
  }

  let discovered = 0;
  let drained = 0;

  // Drain owners with bounded parallelism. Upstream loops sequentially, but
  // the drain runs inside the (serial) batch-processing loop, so its wall time
  // directly starves event processing — metrics showed the account-orders
  // effect alone at ~54% of backfill wall time. Per-owner drains are
  // independent (distinct progress rows, distinct cache rows), and the
  // orderbook 429 backoff remains the API-level throttle.
  const DRAIN_CONCURRENCY = 5;

  async function drainOne(owner: Hex): Promise<void> {
    try {
      // The deadline is passed through so a timed-out drain's orphaned
      // continuation bails cooperatively instead of touching handler context
      // after this handler has resolved.
      const deadline = Date.now() + BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS;
      const { orders, complete } = await withTimeout(
        fetchComposableOrders(context, chainId, owner, deadline),
        BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS,
        `OwnerBackfill:owner:${owner}`,
      );
      discovered += await upsertDiscreteOrders(context, chainId, orders);

      // Only flip the flag when the owner's history was drained in full. A partial
      // drain (rate limit / timeout) leaves the owner eligible → retried next block.
      if (complete) {
        for (const genId of ownerGeneratorIds.get(owner) ?? []) {
          const gen = await context.ConditionalOrderGenerator.get(genId);
          if (gen) context.ConditionalOrderGenerator.set({ ...gen, historyBackfilled: true });
        }
        drained++;
      } else if (!context.isPreload) {
        log("warn", "OwnerBackfill:owner_incomplete", { block: String(currentBlock), chainId, owner });
      }
    } catch (err) {
      if (err instanceof TimeoutError) {
        log("warn", "OwnerBackfill:owner_timeout", { block: String(currentBlock), chainId, owner, timeoutMs: BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS });
        return; // leave eligible — retried next block
      }
      throw err;
    }
  }

  for (let i = 0; i < owners.length; i += DRAIN_CONCURRENCY) {
    await Promise.all(owners.slice(i, i + DRAIN_CONCURRENCY).map(drainOne));
  }

  if (!context.isPreload) {
    log("info", "OwnerBackfill:DONE", { block: String(currentBlock), chainId, phase, owners: owners.length, drained, discovered });
  }
}

if (!isTest) {
  // Tip-only drain (upstream fc746d8): the historical registration interleaved
  // orderbook I/O with the event backfill and dragged out the path to synced.
  // Coverage is unchanged — historical non-deterministic generators keep
  // historyBackfilled=false and are drained once sync reaches the tip.
  indexer.onBlock(
    {
      name: "OwnerBackfillLive",
      where: ({ chain }) => ({ block: { number: { _gte: pollerActivationFloor(chain.id), _every: blockHandlerInterval(chain.id) } } }),
    },
    async ({ block, context }) => {
      if (!context.chain.isRealtime) return; // startBlock "latest" upstream
      await drainOwnerBatch(block, context, "live");
    },
  );
}
