/**
 * FlashLoanOrderEnricher — per-block enrichment of new live flash_loan_order
 * rows, plus any stragglers the backfiller left (timeouts / not-yet-on-API).
 * Capped per block, oldest-first. Ported from the upstream ponder indexer's
 * flashLoanOrderEnricher.ts.
 *
 * FlashLoanOrderBackfiller — drains, from go-live, the historical backlog the
 * settlement handler recorded during backfill. Upstream does it in one firing
 * (startBlock=endBlock="latest") inside a per-chain process; here a firing
 * holds the batch commit for every chain, so it takes one slice per firing
 * until the backlog fits in one.
 */

import { indexer } from "envio";
import {
  DEFAULT_MAX_FLASH_LOAN_ORDERS_PER_BLOCK,
  FLASH_LOAN_BACKFILL_SLICE_SIZE,
} from "../constants.js";
import { log } from "../helpers/logger.js";
import { blockHandlerInterval, blockTimestamp, isTest, paced, nextHexBucket, pollerBlockFilter, resolveCap } from "../helpers/blockHandlerShared.js";
import { selectPendingFlashLoanOrders, enrichFlashLoanOrders } from "../helpers/flashLoanShared.js";

// Chains whose backlog is drained, per process (upstream achieves this with
// startBlock=endBlock="latest" so the handler fires exactly once per deploy).
const backfillDone = new Set<number>();

if (!isTest) {
  indexer.onBlock(
    {
      name: "FlashLoanOrderBackfiller",
      where: ({ chain }) => pollerBlockFilter(chain.id),
    },
    paced("FlashLoanOrderBackfiller", async ({ block, context }) => {
      if (!context.chain.isRealtime) return;
      const chainId = context.chain.id;
      if (backfillDone.has(chainId)) return;

      const pending = await selectPendingFlashLoanOrders(context);
      if (pending.length <= FLASH_LOAN_BACKFILL_SLICE_SIZE) backfillDone.add(chainId);
      if (pending.length === 0) return;

      const slice = pending.slice(0, FLASH_LOAN_BACKFILL_SLICE_SIZE);
      const { enriched, missing } = await enrichFlashLoanOrders(context, await blockTimestamp(context, block), slice);
      log("info", "FlashLoanOrderBackfiller:SLICE", { block: String(block.number), chainId, pending: pending.length, enriched, missing });
    }),
  );

  indexer.onBlock(
    {
      name: "FlashLoanOrderEnricher",
      where: ({ chain }) => pollerBlockFilter(chain.id),
    },
    paced("FlashLoanOrderEnricher", async ({ block, context }) => {
      if (!context.chain.isRealtime) return; // startBlock "latest" upstream

      const chainId = context.chain.id;
      const maxPerBlock = resolveCap(
        `MAX_FLASH_LOAN_ORDERS_PER_BLOCK_${chainId}`,
        DEFAULT_MAX_FLASH_LOAN_ORDERS_PER_BLOCK,
      );

      const pending = await selectPendingFlashLoanOrders(
        context, maxPerBlock, nextHexBucket(`flenrich:${chainId}`),
      );
      if (pending.length === 0) return;

      const { enriched, missing } = await enrichFlashLoanOrders(
        context, await blockTimestamp(context, block), pending,
      );

      if (!context.isPreload) {
        log("info", "FlashLoanOrderEnricher:DONE", { block: String(block.number), chainId, pending: pending.length, enriched, missing });
      }
    }),
  );
}
