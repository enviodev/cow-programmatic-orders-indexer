/**
 * Orderbook client — fetches and caches composable orders from the CoW Orderbook API.
 * Ported from the upstream ponder indexer's orderbook/client.ts.
 *
 * Cache strategy (per-UID):
 * - OrderUidCache stores per-UID terminal statuses (terminal orders never re-fetched)
 * - Open/non-cached orders are refreshed via POST /api/v1/orders/by_uids
 *
 * KNOWN LIMITATION — Off-chain cancellation gap:
 *   Orders cancelled via the CoW Orderbook API's DELETE endpoint (off-chain
 *   soft cancel) are NOT detected after they've been cached as terminal.
 */

import { type Hex } from "viem";
import { ORDERBOOK_API_URLS } from "../../data.js";
import {
  ORDERBOOK_HTTP_TIMEOUT_MS,
  SIGNING_SCHEME_EIP1271,
} from "../../constants.js";
import { TimeoutError, withTimeout } from "../withTimeout.js";
import { log } from "../logger.js";
import { fetchAccountHistoryPage, fetchAccountOrders, fetchOrdersByUids } from "./http.js";
import {
  cacheFlashLoanEnrichment,
  cacheUidStatuses,
  getCachedFlashLoanEnrichment,
  getCachedUidStatuses,
  readOwnerBackfillCursor,
  readOwnerComposableCache,
  toCacheRow,
  upsertComposableCache,
} from "./cache.js";
import {
  filterAndProcess,
  reconcileOpenCachedRows,
  remapToCurrentGenerators,
} from "./processing.js";
import {
  PAGE_LIMIT,
  TERMINAL_STATUSES,
  toDiscreteStatus,
  type ComposableOrder,
  type FlashLoanEnrichment,
  type OrderStatusInfo,
  type OrderbookOrder,
} from "./types.js";

// ─── Public API ──────────────────────────────────────────────────────────────

// Pages fetched per firing during the bounded full-history drain. Large owners
// (market makers with tens of thousands of orders) drain across multiple
// OwnerBackfill firings; each page is up to 1000 orders / several MB.
const DRAIN_PAGES_PER_FIRING = 3;

/**
 * Fetch composable orders for an owner, using the per-UID cache for terminal
 * orders and the durable ComposableOrderCache for the incremental drain.
 *
 * Two phases, tracked in OwnerDrainProgress:
 *
 * A. Full-history drain (progress.complete=false): fetch a bounded window of
 *    DRAIN_PAGES_PER_FIRING pages from progress.nextOffset, persist the delta,
 *    advance the offset, and return complete=false until the last page is
 *    reached. This replaces upstream's unbounded single fetch — in ponder a
 *    timed-out drain's orphaned promise still finishes its cow_cache writes in
 *    the background, but envio rejects entity writes after the handler
 *    resolves, so progress must be made durable within each firing. (Offset
 *    drift from new orders arriving mid-drain only pushes rows to higher
 *    offsets — re-fetch, never skip; upserts make re-fetch harmless.)
 *
 * B. Delta drain (progress.complete=true — upstream's steady state):
 * 1. cursor = newest creationDate already cached for this owner
 * 2. Fetch /account/{owner}/orders newest-first, stopping once older than the cursor
 * 3. Decode → filter to composable → match to generators, then persist the delta
 *
 * Then (both phases, once complete): rebuild the full owner set from the
 * durable cache, re-check still-open cached rows via by_uids, and re-map
 * generatorHash → the current generator id.
 */
export async function fetchComposableOrders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  owner: Hex,
  // Epoch-ms deadline (cooperative): callers that race this promise against a
  // timeout pass the same deadline so the orphaned continuation stops BEFORE
  // touching handler context after the handler resolved (envio rejects late
  // entity access). Expired → returns complete:false, retried on a later block.
  deadline?: number,
): Promise<{ orders: ComposableOrder[]; complete: boolean }> {
  const expired = () => deadline !== undefined && Date.now() >= deadline;
  const apiBaseUrl = ORDERBOOK_API_URLS[chainId];
  if (!apiBaseUrl) {
    log("warn", "ob:noApiUrl", { chainId });
    return { orders: [], complete: false };
  }

  const progressId = `${chainId}_${owner.toLowerCase()}`;
  const progress = await context.OwnerDrainProgress.get(progressId);

  let deltaCount = 0;

  if (!progress?.complete) {
    // Phase A — bounded, resumable full-history drain. Pages are served from
    // the persistent effect cache on repeat backfills (see
    // orderbookAccountHistoryPage), so re-syncs cost ~zero orderbook I/O here.
    const startOffset = progress?.nextOffset ?? 0;
    log("info", "ob:fetch", { owner, chainId, phase: "history", offset: startOffset });

    const page = await fetchAccountHistoryPage(
      context, chainId, owner, startOffset, DRAIN_PAGES_PER_FIRING,
    );
    if (expired()) return { orders: [], complete: false };

    const delta = await filterAndProcess(context, chainId, page.orders);
    if (expired()) return { orders: [], complete: false };
    await upsertComposableCache(context, chainId, owner, delta.map(toCacheRow));
    deltaCount = delta.length;

    // Persist resume state — this is what makes retries converge. Only advance
    // when the window actually progressed (an errored first page keeps state).
    if (page.nextOffset > startOffset || page.complete) {
      context.OwnerDrainProgress.set({
        id: progressId,
        chainId,
        owner: owner.toLowerCase(),
        nextOffset: page.nextOffset,
        complete: page.complete,
      });
    }

    if (!page.complete) {
      log("info", "ob:fetchResult", { owner, chainId, phase: "history", delta: deltaCount, nextOffset: page.nextOffset, complete: false });
      return { orders: [], complete: false }; // resumed next firing
    }
    // Fall through to the delta pass: history pages may have been replayed
    // from the effect cache, so an uncached cursor fetch picks up anything
    // newer than the cached history before the owner is marked backfilled.
  }

  // Phase B — incremental delta drain from the creation-date cursor (uncached).
  const cursor = await readOwnerBackfillCursor(context, chainId, owner);
  log("info", "ob:fetch", { owner, chainId, since: cursor ?? null });

  const delta_ = await fetchAccountOrders(
    context, chainId, owner, 0, SIGNING_SCHEME_EIP1271, PAGE_LIMIT, cursor,
  );
  if (expired()) return { orders: [], complete: false };
  const delta = await filterAndProcess(context, chainId, delta_.orders);
  if (expired()) return { orders: [], complete: false };
  await upsertComposableCache(context, chainId, owner, delta.map(toCacheRow));
  deltaCount += delta.length;
  if (!delta_.complete) return { orders: [], complete: false };

  // Rebuild the full owner set from the durable cache (delta + everything older).
  const cachedRows = await readOwnerComposableCache(context, chainId, owner);
  if (expired()) return { orders: [], complete: false };

  // Re-check any still-open cached rows — long-lived orders that terminated
  // earlier would otherwise keep a stale "open" status forever.
  const reconciled = await reconcileOpenCachedRows(context, chainId, owner, cachedRows);
  if (expired()) return { orders: [], complete: false };

  // Re-map by the stable hash to the current generator id.
  const results = await remapToCurrentGenerators(context, chainId, reconciled);

  log("info", "ob:fetchResult", { owner, chainId, delta: deltaCount, total: results.length, complete: true });
  return { orders: results, complete: true };
}

/**
 * Upsert composable orders into DiscreteOrder.
 * On conflict the API's authoritative status/validTo/executed overwrite the
 * existing row (other fields — incl. promotedAt — are preserved).
 */
export async function upsertDiscreteOrders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  orders: ComposableOrder[],
): Promise<number> {
  if (orders.length === 0) return 0;
  for (const order of orders) {
    const id = `${chainId}_${order.uid}`;
    const existing = await context.DiscreteOrder.get(id);
    if (existing) {
      context.DiscreteOrder.set({
        ...existing,
        status: toDiscreteStatus(order.status),
        validTo: order.validTo != null ? BigInt(order.validTo) : undefined,
        executedSellAmount: order.executedSellAmount ?? undefined,
        executedBuyAmount: order.executedBuyAmount ?? undefined,
      });
    } else {
      context.DiscreteOrder.set({
        id,
        orderUid: order.uid,
        chainId,
        conditionalOrderGenerator_id: order.generatorId,
        status: toDiscreteStatus(order.status),
        sellAmount: order.sellAmount,
        buyAmount: order.buyAmount,
        feeAmount: order.feeAmount,
        validTo: order.validTo != null ? BigInt(order.validTo) : undefined,
        creationDate: order.creationDate,
        executedSellAmount: order.executedSellAmount ?? undefined,
        executedBuyAmount: order.executedBuyAmount ?? undefined,
        promotedAt: undefined,
      });
    }
  }
  return orders.length;
}

/**
 * Fetch order statuses by UIDs from the API, using the per-UID cache.
 * Returns a Map of uid -> OrderStatusInfo. Executed amounts are null for
 * cached results (the amounts are already stored in DiscreteOrder from
 * the original fresh fetch).
 */
export async function fetchOrderStatusByUids(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  uids: string[],
): Promise<Map<string, OrderStatusInfo>> {
  const result = new Map<string, OrderStatusInfo>();
  if (uids.length === 0) return result;

  const apiBaseUrl = ORDERBOOK_API_URLS[chainId];
  if (!apiBaseUrl) return result;

  // Check cache first
  const cached = await getCachedUidStatuses(context, chainId, uids);
  const toFetch: string[] = [];

  for (const uid of uids) {
    const cachedData = cached.get(uid);
    if (cachedData && TERMINAL_STATUSES.has(cachedData.status)) {
      result.set(uid, {
        status: cachedData.status,
        executedSellAmount: cachedData.executedSellAmount,
        executedBuyAmount: cachedData.executedBuyAmount,
      });
    } else {
      toFetch.push(uid);
    }
  }

  // Batch-fetch non-cached UIDs, capped at 2 × the per-request timeout.
  if (toFetch.length > 0) {
    let fetched: OrderbookOrder[];
    try {
      fetched = await withTimeout(
        fetchOrdersByUids(context, chainId, toFetch),
        ORDERBOOK_HTTP_TIMEOUT_MS * 2,
        "ob:statusByUids",
      );
    } catch (err) {
      if (err instanceof TimeoutError) {
        log("warn", "ob:statusByUidsTimeout", { chainId, toFetch: toFetch.length, after: ORDERBOOK_HTTP_TIMEOUT_MS * 2 });
        return result; // cache-only map — caller treats missing UIDs as "not on API yet"
      }
      throw err;
    }

    const newTerminal: ComposableOrder[] = [];

    for (const order of fetched) {
      result.set(order.uid, {
        status: order.status,
        executedSellAmount: order.executedSellAmount,
        executedBuyAmount: order.executedBuyAmount,
      });
      if (TERMINAL_STATUSES.has(order.status)) {
        newTerminal.push({
          uid: order.uid,
          status: order.status,
          generatorId: "",
          generatorHash: "",
          orderType: "Unknown",
          sellAmount: order.sellAmount,
          buyAmount: order.buyAmount,
          feeAmount: order.feeAmount,
          validTo: order.validTo,
          creationDate: 0n,
          executedSellAmount: order.executedSellAmount,
          executedBuyAmount: order.executedBuyAmount,
        });
      }
    }

    if (newTerminal.length > 0) {
      await cacheUidStatuses(context, chainId, newTerminal);
    }
  }

  return result;
}

/**
 * Fallback status lookup via GET /account/{owner}/orders.
 * Used when /orders/by_uids returns nothing for UIDs that may have aged out
 * of the API's retention window (e.g. TWAP parts near or past validTo).
 */
export async function fetchOwnerOrderStatuses(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  owner: Hex,
  maxPages = 3,
): Promise<Map<string, OrderStatusInfo>> {
  const result = new Map<string, OrderStatusInfo>();
  const apiBaseUrl = ORDERBOOK_API_URLS[chainId];
  if (!apiBaseUrl) return result;
  const { orders } = await fetchAccountOrders(context, chainId, owner, maxPages);
  for (const order of orders) {
    result.set(order.uid, {
      status: order.status,
      executedSellAmount: order.executedSellAmount,
      executedBuyAmount: order.executedBuyAmount,
    });
  }
  return result;
}

/**
 * Fetch CoW-order detail for flash-loan order UIDs, cache-first.
 * Flash-loan orders are always settled (terminal), so a fetched result never
 * goes stale. UIDs absent from both cache and API are omitted — the caller
 * retries on a later block.
 */
export async function fetchFlashLoanEnrichmentByUids(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  uids: string[],
): Promise<Map<string, FlashLoanEnrichment>> {
  const result = new Map<string, FlashLoanEnrichment>();
  if (uids.length === 0) return result;

  const apiBaseUrl = ORDERBOOK_API_URLS[chainId];
  if (!apiBaseUrl) return result;

  // Cache first.
  const cached = await getCachedFlashLoanEnrichment(context, chainId, uids);
  const toFetch: string[] = [];
  for (const uid of uids) {
    const hit = cached.get(uid);
    if (hit) result.set(uid, hit);
    else toFetch.push(uid);
  }
  if (toFetch.length === 0) return result;

  let fetched: OrderbookOrder[];
  try {
    fetched = await withTimeout(
      fetchOrdersByUids(context, chainId, toFetch),
      ORDERBOOK_HTTP_TIMEOUT_MS * 2,
      "ob:flashLoanByUids",
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      log("warn", "ob:flashLoanByUidsTimeout", { chainId, toFetch: toFetch.length, after: ORDERBOOK_HTTP_TIMEOUT_MS * 2 });
      return result; // cache-only — caller treats missing UIDs as "not on API yet"
    }
    throw err;
  }

  const newlyFetched: { uid: string; enrichment: FlashLoanEnrichment }[] = [];
  for (const order of fetched) {
    const enrichment: FlashLoanEnrichment = {
      receiver: order.receiver ? order.receiver.toLowerCase() : null,
      kind: order.kind,
      sellAmount: order.sellAmount,
      buyAmount: order.buyAmount,
      executedSellAmount: order.executedSellAmount,
      executedBuyAmount: order.executedBuyAmount,
    };
    result.set(order.uid, enrichment);
    newlyFetched.push({ uid: order.uid, enrichment });
  }

  if (newlyFetched.length > 0) {
    await cacheFlashLoanEnrichment(context, chainId, newlyFetched);
  }

  return result;
}
