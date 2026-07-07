/**
 * Shared flash-loan enrichment logic — ported from the upstream ponder
 * indexer's handlers/block/shared.ts. Used by both FlashLoanOrderBackfiller
 * and FlashLoanOrderEnricher.
 */

import { MAX_FLASH_LOAN_ENRICHMENT_ATTEMPTS } from "../constants.js";
import { fetchFlashLoanEnrichmentByUids } from "./orderbook/client.js";
import { log } from "./logger.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PendingFlashLoanRow = any; // FlashLoanOrder entity row

/** Select pending (un-enriched, under the attempt cap) flash-loan orders, oldest-first. */
export async function selectPendingFlashLoanOrders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  limit?: number,
): Promise<PendingFlashLoanRow[]> {
  const pending = await context.FlashLoanOrder.getWhere({
    chainId: { _eq: chainId },
    enriched: { _eq: false },
    enrichmentAttempts: { _lt: MAX_FLASH_LOAN_ENRICHMENT_ATTEMPTS },
  });
  const sorted = pending.sort(
    (a: PendingFlashLoanRow, b: PendingFlashLoanRow) => Number(a.blockNumber - b.blockNumber),
  );
  return limit !== undefined ? sorted.slice(0, limit) : sorted;
}

/**
 * Enrich one batch of pending rows from the orderbook (cache-first) and persist.
 * Hits → upsert writing the orderbook fields + enrichedAt.
 * Misses (not yet on the API) → bump enrichmentAttempts so they eventually stop
 * being polled. On an orderbook fetch failure, leaves the batch pending.
 */
export async function enrichFlashLoanOrders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  enrichedAtTs: bigint,
  rows: PendingFlashLoanRow[],
): Promise<{ enriched: number; missing: number }> {
  if (rows.length === 0) return { enriched: 0, missing: 0 };

  let enrichment: Awaited<ReturnType<typeof fetchFlashLoanEnrichmentByUids>>;
  try {
    enrichment = await fetchFlashLoanEnrichmentByUids(
      context, chainId, rows.map((o: PendingFlashLoanRow) => o.orderUid),
    );
  } catch (err) {
    log("warn", "FlashLoanEnrich:fetch_failed", { chainId, uids: rows.length, err: err instanceof Error ? err.message : String(err) });
    return { enriched: 0, missing: 0 }; // leave pending — retried on a later block
  }

  let enriched = 0;
  let missing = 0;

  for (const order of rows) {
    const info = enrichment.get(order.orderUid);
    if (!info) {
      context.FlashLoanOrder.set({
        ...order,
        enrichmentAttempts: order.enrichmentAttempts + 1,
      });
      missing++;
      continue;
    }
    context.FlashLoanOrder.set({
      ...order,
      executedSellAmount: info.executedSellAmount,
      executedBuyAmount: info.executedBuyAmount,
      receiver: info.receiver ?? undefined,
      kind: info.kind,
      sellAmountIntended: info.sellAmount,
      buyAmountIntended: info.buyAmount,
      enriched: true,
      enrichedAt: enrichedAtTs,
    });
    enriched++;
  }

  return { enriched, missing };
}
