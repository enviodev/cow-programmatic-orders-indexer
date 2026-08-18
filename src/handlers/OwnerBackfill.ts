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
 *
 * Each owner attempt is a bounded, RESUMABLE slice: progress is persisted
 * page-by-page in OwnerDrainProgress, so hitting the slice deadline just
 * pauses the drain and a later firing resumes from the stored offset. Owners
 * are picked least-recently-attempted first (never-attempted first), so a
 * slow owner can't monopolize the batch and starve the rest.
 *
 * Unknown and CowAmmConstantProduct generators are stored but never drained —
 * see OWNER_BACKFILL_EXCLUDED in utils/order-types.ts.
 */

import { indexer } from "envio";
import type { Hex } from "viem";
import {
  BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_OWNERS_BACKFILL_PER_BLOCK,
  DEFAULT_OWNER_BACKFILL_CONCURRENCY,
} from "../constants.js";
import { fetchComposableOrders, upsertDiscreteOrders } from "../helpers/orderbook/client.js";
import { mapWithConcurrency } from "../helpers/concurrency.js";
import { TimeoutError, withTimeout } from "../helpers/withTimeout.js";
import { log } from "../helpers/logger.js";
import { blockHandlerInterval, isTest, nextHexBucket, pollerBlockFilter, resolveCap } from "../helpers/blockHandlerShared.js";
import { OWNER_BACKFILL_TYPES } from "../utils/order-types.js";

// Shared drain — registered for both the historical and live block handlers below.
async function drainOwnerBatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  block: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  phase: "historical" | "live",
): Promise<void> {
  // Ops escape hatch: the /account drain is the heaviest consumer of the
  // orderbook's per-IP budget; disable it on hosts whose IP is rate-penalized
  // and run it elsewhere (the historyBackfilled flags keep the backlog).
  if (process.env.DISABLE_OWNER_BACKFILL === "1") return;
  const chainId = context.chain.id;
  const currentBlock = BigInt(block.number);
  const cap = resolveCap(
    `MAX_OWNERS_BACKFILL_PER_BLOCK_${chainId}`,
    DEFAULT_MAX_OWNERS_BACKFILL_PER_BLOCK,
  );

  // Bounded scan: one hash-nibble bucket per firing (~1/16 of the backlog).
  // Unknown and CowAmmConstantProduct generators are stored but never drained —
  // see OWNER_BACKFILL_EXCLUDED in utils/order-types.ts.
  const eligible = await context.ConditionalOrderGenerator.getWhere({
    status: { _eq: "Active" },
    orderType: { _in: [...OWNER_BACKFILL_TYPES] },
    historyBackfilled: { _eq: false },
    hash: nextHexBucket(`ownerdrain:${chainId}`),
  });

  if (eligible.length === 0) return; // nothing pending in this bucket — cheap no-op

  // Take up to `cap` distinct owners this block, least-recently-attempted first
  // (never-attempted first, then by owner for determinism) so a repeatedly slow
  // owner rotates to the back of the queue instead of occupying every batch.
  const distinctOwners = [...new Set(eligible.map((g: { owner: string }) => g.owner))] as Hex[];
  const attemptAt = new Map<string, bigint | undefined>();
  for (const o of distinctOwners) {
    const progress = await context.OwnerDrainProgress.get(o.toLowerCase());
    attemptAt.set(o, progress?.lastAttemptAt);
  }
  const owners = distinctOwners
    .sort((a, b) => {
      const la = attemptAt.get(a);
      const lb = attemptAt.get(b);
      if (la == null && lb == null) return a < b ? -1 : 1;
      if (la == null) return -1;
      if (lb == null) return 1;
      if (la !== lb) return la < lb ? -1 : 1;
      return a < b ? -1 : 1;
    })
    .slice(0, cap);

  // Generator ids for the selected owners, to flip historyBackfilled after a clean drain.
  const ownerGeneratorIds = new Map<string, string[]>();
  for (const g of eligible) {
    if (!owners.includes(g.owner as Hex)) continue;
    const existing = ownerGeneratorIds.get(g.owner) ?? [];
    existing.push(g.id);
    ownerGeneratorIds.set(g.owner, existing);
  }

  const concurrency = resolveCap(
    `MAX_OWNERS_BACKFILL_CONCURRENCY_${chainId}`,
    DEFAULT_OWNER_BACKFILL_CONCURRENCY,
  );

  if (!context.isPreload) {
    log("info", "OwnerBackfill:START", { block: String(currentBlock), chainId, phase, owners: owners.length, cap, concurrency });
  }

  // Stamp lastAttemptAt at attempt start (drives the rotation above).
  async function stampAttempt(owner: Hex): Promise<void> {
    const id = owner.toLowerCase();
    const prev = await context.OwnerDrainProgress.get(id);
    context.OwnerDrainProgress.set({
      id,
      owner: id,
      nextOffset: prev?.nextOffset ?? 0,
      complete: prev?.complete ?? false,
      deltaCursor: prev?.deltaCursor,
      lastAttemptAt: BigInt(Math.floor(Date.now() / 1000)),
    });
  }

  // One drain slice for one owner. A timeout or incomplete slice needs no
  // special handling — pages are already persisted with the resume state, so
  // the owner just continues on a later firing. Errors propagate to abort the
  // batch (the block handler is idempotent, so the block simply retries).
  async function drainOne(owner: Hex): Promise<{ discovered: number; drained: number }> {
    await stampAttempt(owner);
    try {
      // The deadline is passed through so a timed-out drain's orphaned
      // continuation bails cooperatively instead of touching handler context
      // after this handler has resolved.
      const deadline = Date.now() + BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS;
      const { orders, complete } = await withTimeout(
        fetchComposableOrders(context, owner, deadline),
        BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS,
        `OwnerBackfill:owner:${owner}`,
      );
      const discovered = await upsertDiscreteOrders(context, orders);

      // Only flip the flag when the owner's history was drained in full. A partial
      // drain (rate limit / timeout) leaves the owner eligible → retried next block.
      if (complete) {
        for (const genId of ownerGeneratorIds.get(owner) ?? []) {
          const gen = await context.ConditionalOrderGenerator.get(genId);
          if (gen) context.ConditionalOrderGenerator.set({ ...gen, historyBackfilled: true });
        }
        return { discovered, drained: 1 };
      }
      if (!context.isPreload) {
        log("info", "OwnerBackfill:owner_paused", { block: String(currentBlock), chainId, owner });
      }
      return { discovered, drained: 0 };
    } catch (err) {
      if (err instanceof TimeoutError) {
        log("warn", "OwnerBackfill:owner_timeout", { block: String(currentBlock), chainId, owner, timeoutMs: BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS });
        return { discovered: 0, drained: 0 }; // leave eligible — retried next block
      }
      throw err;
    }
  }

  // Owner fetches are independent HTTP round-trips, so run them through a
  // bounded worker pool rather than one-at-a-time: wall-clock per firing drops
  // from cap × timeout to ~ceil(cap / concurrency) × timeout, and concurrency
  // caps in-flight orderbook load (the 429 backoff remains the API throttle).
  const tallies = await mapWithConcurrency(owners, concurrency, drainOne);
  const discovered = tallies.reduce((sum, t) => sum + t.discovered, 0);
  const drained = tallies.reduce((sum, t) => sum + t.drained, 0);

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
      where: ({ chain }) => pollerBlockFilter(chain.id),
    },
    async ({ block, context }) => {
      if (!context.chain.isRealtime) return; // startBlock "latest" upstream
      await drainOwnerBatch(block, context, "live");
    },
  );
}
