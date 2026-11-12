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
import { decodedOrderFromGenerator, precomputeAndDiscover, precomputeOrderUids } from "../helpers/uidPrecompute.js";
import { fetchOrderStatusByUids } from "../helpers/orderbook/client.js";
import { blockHandlerInterval, blockTimestamp, isTest, paced, nextHexBucket, pollerBlockFilter, resolveCap } from "../helpers/blockHandlerShared.js";
import { log } from "../helpers/logger.js";
import type { Hex } from "viem";

const DEFAULT_MAX_PRECOMPUTES_PER_BLOCK = 25;
// Status lookups per firing, fetched in one batch (100 UIDs per request).
// Block handlers hold the batch commit for every chain, so a firing asks for
// about what the orderbook pacer can serve within its wait limit; the first
// generator is always taken, however many parts it has.
const MAX_UIDS_PER_FIRING = 500;

if (!isTest) {
  indexer.onBlock(
    {
      name: "PrecomputeBackfiller",
      where: ({ chain }) => pollerBlockFilter(chain.id),
    },
    paced("PrecomputeBackfiller", async ({ block, context }) => {
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

      // Upstream precomputes inline at creation, so its rows carry the
      // creation block's timestamp as creationDate. The deferred drain must
      // do the same — the generator id embeds its creation block, and the
      // cached getBlockTimestamp effect resolves the header. The same
      // timestamp resolves TWAP t0 = 0 when the staticInput is re-decoded.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prepared = await Promise.all(batch.map(async (gen: any) => {
        const creationTs = await blockTimestamp(context, { number: Number(gen.id.split("_")[0]) });
        const decodedOrder = decodedOrderFromGenerator(gen, creationTs);
        const uids = (precomputeOrderUids(chainId, gen.owner as Hex, decodedOrder, creationTs) ?? [])
          .map((o) => o.orderUid);
        return { gen, creationTs, decodedOrder, uids };
      }));

      let uidCount = 0;
      const selected = prepared.filter((p, i) => {
        if (i > 0 && uidCount + p.uids.length > MAX_UIDS_PER_FIRING) return false;
        uidCount += p.uids.length;
        return true;
      });
      const statuses = await fetchOrderStatusByUids(context, selected.flatMap((p) => p.uids), "PrecomputeBackfiller");

      for (const { gen, creationTs, decodedOrder } of selected) {
        await precomputeAndDiscover(
          context,
          gen.id,
          gen.owner as Hex,
          decodedOrder,
          creationTs,
          BigInt(block.number),
          statuses,
        );
        // Re-read: precomputeAndDiscover may have updated status/allCandidatesKnown.
        const fresh = await context.ConditionalOrderGenerator.get(gen.id);
        if (fresh) {
          context.ConditionalOrderGenerator.set({ ...fresh, precomputePending: false });
        }
      }

      if (!context.isPreload) {
        log("info", "PrecomputeBackfiller:DONE", { block: String(block.number), chainId, pending: pending.length, done: selected.length, uids: uidCount });
      }
    }),
  );
}
