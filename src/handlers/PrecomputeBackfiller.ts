/**
 * PrecomputeBackfiller — runs UID precompute for deterministic generators that
 * were created during the historical backfill (flagged precomputePending by
 * the ComposableCoW handler).
 *
 * No direct upstream equivalent: upstream runs precompute inline during their
 * backfill and pays for it in deploy time. Deferring it to the tip keeps the
 * chain backfill pure HyperSync event streaming, then drains the orderbook
 * work in bounded per-firing batches — the same shape upstream adopted for the
 * owner-history drain in fc746d8. Final generator states are identical.
 */

import { indexer } from "envio";
import { precomputeAndDiscover } from "../helpers/uidPrecompute.js";
import { blockHandlerInterval, blockTimestamp, isTest, nextHexBucket, pollerBlockFilter, resolveCap } from "../helpers/blockHandlerShared.js";
import { log } from "../helpers/logger.js";
import { type OrderType } from "../utils/order-types.js";
import type { Hex } from "viem";

const DEFAULT_MAX_PRECOMPUTES_PER_BLOCK = 25;

if (!isTest) {
  indexer.onBlock(
    {
      name: "PrecomputeBackfiller",
      where: ({ chain }) => pollerBlockFilter(chain.id),
    },
    async ({ block, context }) => {
      if (!context.chain.isRealtime) return;

      const chainId = context.chain.id;
      const cap = resolveCap(
        `MAX_PRECOMPUTES_PER_BLOCK_${chainId}`,
        DEFAULT_MAX_PRECOMPUTES_PER_BLOCK,
      );

      // Bounded scan: one hash-nibble bucket per firing (~1/16 of pending).
      const bucket = nextHexBucket(`precompute:${chainId}`);
      const pending = await context.ConditionalOrderGenerator.getWhere({
        precomputePending: { _eq: true },
        hash: bucket,
      });
      if (pending.length === 0) return;

      const batch = pending
        // Oldest first (id embeds the block number).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .sort((a: any, b: any) => (a.id < b.id ? -1 : 1))
        .slice(0, cap);

      const ts = await blockTimestamp(context, block);
      let done = 0;

      // Wall-clock budget per firing: under orderbook 429 penalties a single
      // status fetch can legitimately take 30-60s, and an unbounded loop over
      // the batch holds the whole processing batch (and every DB flush) open
      // for tens of minutes. Stop early and leave the rest pending — the next
      // firing resumes.
      const FIRING_BUDGET_MS = 45_000;
      const start = Date.now();

      for (const gen of batch) {
        if (Date.now() - start > FIRING_BUDGET_MS) break;
        await precomputeAndDiscover(
          context,
          gen.id,
          gen.owner as Hex,
          gen.orderType as OrderType,
          (gen.decodedParams ?? null) as Record<string, string> | null,
          ts,
          BigInt(block.number),
        );
        // Re-read: precomputeAndDiscover may have updated status/allCandidatesKnown.
        const fresh = await context.ConditionalOrderGenerator.get(gen.id);
        if (fresh) {
          context.ConditionalOrderGenerator.set({ ...fresh, precomputePending: false });
        }
        done++;
      }

      if (!context.isPreload) {
        log("info", "PrecomputeBackfiller:DONE", { block: String(block.number), chainId, pending: pending.length, done, budgetMs: Date.now() - start });
      }
    },
  );
}
