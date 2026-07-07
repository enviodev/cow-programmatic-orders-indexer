/**
 * FlashLoanOrderEnricher — per-block enrichment of new live flash_loan_order
 * rows, plus any stragglers the backfiller left (timeouts / not-yet-on-API).
 * Capped per block, oldest-first. Ported from the upstream ponder indexer's
 * flashLoanOrderEnricher.ts.
 *
 * FlashLoanOrderBackfiller — fires once at go-live (upstream
 * startBlock=endBlock="latest"), bulk-draining the historical backlog the
 * settlement handler recorded during backfill, in bounded sequential slices.
 */

import { indexer } from "envio";
import {
  DEFAULT_MAX_FLASH_LOAN_ORDERS_PER_BLOCK,
  FLASH_LOAN_BACKFILL_SLICE_SIZE,
} from "../constants.js";
import { log } from "../helpers/logger.js";
import { blockHandlerInterval, blockTimestamp, isTest, resolveCap } from "../helpers/blockHandlerShared.js";
import { selectPendingFlashLoanOrders, enrichFlashLoanOrders } from "../helpers/flashLoanShared.js";

// One-shot backfill guard, per chain per process (upstream achieves this with
// startBlock=endBlock="latest" so the handler fires exactly once per deploy).
const backfillRan = new Set<number>();

if (!isTest) {
  indexer.onBlock(
    {
      name: "FlashLoanOrderBackfiller",
      where: ({ chain }) => ({ block: { number: { _every: blockHandlerInterval(chain.id) } } }),
    },
    async ({ block, context }) => {
      if (!context.chain.isRealtime) return;
      const chainId = context.chain.id;
      if (backfillRan.has(chainId)) return;
      backfillRan.add(chainId);

      const pending = await selectPendingFlashLoanOrders(context, chainId);
      if (!context.isPreload) {
        log("info", "FlashLoanOrderBackfiller:START", { block: String(block.number), chainId, pending: pending.length });
      }
      if (pending.length === 0) return;

      let enriched = 0;
      let missing = 0;
      for (let i = 0; i < pending.length; i += FLASH_LOAN_BACKFILL_SLICE_SIZE) {
        const slice = pending.slice(i, i + FLASH_LOAN_BACKFILL_SLICE_SIZE);
        const r = await enrichFlashLoanOrders(context, chainId, (await blockTimestamp(context, block)), slice);
        enriched += r.enriched;
        missing += r.missing;
      }

      if (!context.isPreload) {
        log("info", "FlashLoanOrderBackfiller:DONE", { block: String(block.number), chainId, pending: pending.length, enriched, missing });
      }
    },
  );

  indexer.onBlock(
    {
      name: "FlashLoanOrderEnricher",
      where: ({ chain }) => ({ block: { number: { _every: blockHandlerInterval(chain.id) } } }),
    },
    async ({ block, context }) => {
      if (!context.chain.isRealtime) return; // startBlock "latest" upstream

      const chainId = context.chain.id;
      const maxPerBlock = resolveCap(
        `MAX_FLASH_LOAN_ORDERS_PER_BLOCK_${chainId}`,
        DEFAULT_MAX_FLASH_LOAN_ORDERS_PER_BLOCK,
      );

      const pending = await selectPendingFlashLoanOrders(context, chainId, maxPerBlock);
      if (pending.length === 0) return;

      const { enriched, missing } = await enrichFlashLoanOrders(
        context, chainId, await blockTimestamp(context, block), pending,
      );

      if (!context.isPreload) {
        log("info", "FlashLoanOrderEnricher:DONE", { block: String(block.number), chainId, pending: pending.length, enriched, missing });
      }
    },
  );
}
