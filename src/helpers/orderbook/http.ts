/**
 * Context-aware orderbook HTTP wrappers — same signatures as the upstream
 * orderbook/http.ts, routed through envio effects (src/effects/orderbook.ts)
 * so calls are deduped during preload.
 */

import { type Hex } from "viem";
import {
  orderbookAccountHistoryPage,
  orderbookAccountOrders,
  orderbookOrdersByUids,
  OrderbookUnavailableError,
  type HistoryPageRow,
} from "../../effects/orderbook.js";

export { type HistoryPageRow };
import { PAGE_LIMIT, type OrderbookOrder } from "./types.js";

export { OrderbookUnavailableError };

/** Cached bounded history-page fetch (phase A of the owner drain). Returns
 *  slim pre-decoded rows — see the orderbookAccountHistoryPage effect for the
 *  staleness/self-heal contract and why raw orders are never cached. */
export async function fetchAccountHistoryPage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  owner: Hex,
  startOffset: number,
  maxPages: number,
  pageSize = PAGE_LIMIT,
): Promise<{ rows: HistoryPageRow[]; complete: boolean; nextOffset: number }> {
  const json = await context.effect(orderbookAccountHistoryPage, {
    chainId,
    owner,
    maxPages,
    pageSize,
    offset: startOffset,
  });
  return JSON.parse(json) as { rows: HistoryPageRow[]; complete: boolean; nextOffset: number };
}

/** Fetch orders for an owner with pagination. maxPages limits how many pages are
 *  fetched (0 = unlimited). sinceCreationDate (Unix seconds) enables the
 *  incremental delta drain; startOffset resumes a bounded full-history drain. */
export async function fetchAccountOrders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  owner: Hex,
  maxPages = 0,
  signingScheme?: string,
  pageSize = PAGE_LIMIT,
  sinceCreationDate?: number,
  startOffset = 0,
): Promise<{ orders: OrderbookOrder[]; complete: boolean; nextOffset: number }> {
  const json = await context.effect(orderbookAccountOrders, {
    chainId,
    owner,
    maxPages,
    signingScheme,
    pageSize,
    since: sinceCreationDate,
    offset: startOffset,
  });
  return JSON.parse(json) as { orders: OrderbookOrder[]; complete: boolean; nextOffset: number };
}

/** Batch-fetch orders by UID to refresh status of open orders. */
export async function fetchOrdersByUids(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  uids: string[],
): Promise<OrderbookOrder[]> {
  if (uids.length === 0) return [];
  const json = await context.effect(orderbookOrdersByUids, {
    chainId,
    uidsJson: JSON.stringify(uids),
  });
  return JSON.parse(json) as OrderbookOrder[];
}
