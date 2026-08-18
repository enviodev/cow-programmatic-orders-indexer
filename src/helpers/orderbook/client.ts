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
  ORDERBOOK_BATCH_TIMEOUT_MS,
  SIGNING_SCHEME_EIP1271,
} from "../../constants.js";
import { TimeoutError, withTimeout } from "../withTimeout.js";
import { bumpGeneratorsUpdatedAt } from "../updatedAtBlock.js";
import { refreshTwapExecutedTotals } from "../executedAmounts.js";
import { log } from "../logger.js";
import { fetchAccountHistoryPage, fetchAccountOrders, fetchOrdersByUids } from "./http.js";
import {
  cacheFlashLoanEnrichment,
  cacheUidStatuses,
  getCachedFlashLoanEnrichment,
  getCachedUidStatuses,
  readOwnerComposableCache,
  toCacheRow,
  upsertComposableCache,
} from "./cache.js";
import {
  filterAndProcess,
  matchHistoryRowsToGenerators,
  reconcileOpenCachedRows,
  remapToCurrentGenerators,
} from "./processing.js";
import {
  PAGE_LIMIT,
  TERMINAL_STATUSES,
  toBigIntOrNull,
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
 * Two phases, tracked in OwnerDrainProgress (upstream cow_cache.owner_drain):
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
 *    The newest composable row seen at offset 0 becomes the deltaCursor
 *    candidate (at-or-older than the true newest raw order — overlap, never a
 *    gap; orders created mid-drain are newer and a later delta pass gets them).
 *
 * B. Delta drain (progress.complete=true — upstream's steady state):
 * 1. cursor = progress.deltaCursor — explicit, never derived from cached rows
 *    (MAX(creationDate) conflates "cached this" with "cached everything older",
 *    so a partial delta would advance the cursor past unfetched orders)
 * 2. Fetch /account/{owner}/orders newest-first, stopping once older than the cursor
 * 3. Decode → filter to composable → match to generators, then persist the delta
 * 4. Advance deltaCursor ONLY on a complete pass — an incomplete delta
 *    re-fetches the same window later (overlap, never a gap)
 *
 * Then (both phases, once complete): rebuild the full owner set from the
 * durable cache, re-check still-open cached rows via by_uids, and re-map
 * generatorHash → the current generator id.
 */
export async function fetchComposableOrders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  owner: Hex,
  // Epoch-ms deadline (cooperative): callers that race this promise against a
  // timeout pass the same deadline so the orphaned continuation stops BEFORE
  // touching handler context after the handler resolved (envio rejects late
  // entity access). Expired → returns complete:false, retried on a later block.
  deadline?: number,
): Promise<{ orders: ComposableOrder[]; complete: boolean }> {
  const expired = () => deadline !== undefined && Date.now() >= deadline;
  const chainId = context.chain.id;
  const apiBaseUrl = ORDERBOOK_API_URLS[chainId];
  if (!apiBaseUrl) {
    log("warn", "ob:noApiUrl", { chainId });
    return { orders: [], complete: false };
  }

  const progressId = owner.toLowerCase();
  const progress = await context.OwnerDrainProgress.get(progressId);

  let deltaCount = 0;

  if (!progress?.complete) {
    // Phase A — bounded, resumable full-history drain. Pages are served from
    // the persistent effect cache on repeat backfills (see
    // orderbookAccountHistoryPage), so re-syncs cost ~zero orderbook I/O here.
    const startOffset = progress?.nextOffset ?? 0;
    log("info", "ob:fetch", { owner, chainId, phase: "history", offset: startOffset });

    const page = await fetchAccountHistoryPage(
      context, owner, startOffset, DRAIN_PAGES_PER_FIRING,
    );
    if (expired()) return { orders: [], complete: false };

    const delta = await matchHistoryRowsToGenerators(context, page.rows);
    if (expired()) return { orders: [], complete: false };
    await upsertComposableCache(context, owner, delta.map(toCacheRow));
    deltaCount = delta.length;

    // The newest row of the offset-0 window is the deltaCursor candidate —
    // written alongside the offset so it can never be skipped.
    const candidateCursor =
      startOffset === 0 && page.rows[0]
        ? BigInt(page.rows[0].creationDate)
        : undefined;

    // Persist resume state — this is what makes retries converge. Only advance
    // when the window actually progressed (an errored first page keeps state).
    if (page.nextOffset > startOffset || page.complete) {
      context.OwnerDrainProgress.set({
        id: progressId,
        owner: owner.toLowerCase(),
        nextOffset: page.nextOffset,
        complete: page.complete,
        deltaCursor: candidateCursor ?? progress?.deltaCursor,
        lastAttemptAt: progress?.lastAttemptAt,
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

  // Phase B — incremental delta drain from the explicit deltaCursor (uncached).
  // Re-read progress: phase A may have just written the cursor candidate.
  const progressForDelta = await context.OwnerDrainProgress.get(progressId);
  const cursor =
    progressForDelta?.deltaCursor != null
      ? Number(progressForDelta.deltaCursor)
      : undefined;
  log("info", "ob:fetch", { owner, chainId, since: cursor ?? null });

  const delta_ = await fetchAccountOrders(
    context, owner, 0, SIGNING_SCHEME_EIP1271, PAGE_LIMIT, cursor,
  );
  if (expired()) return { orders: [], complete: false };
  const delta = await filterAndProcess(context, delta_.orders);
  if (expired()) return { orders: [], complete: false };
  await upsertComposableCache(context, owner, delta.map(toCacheRow));
  deltaCount += delta.length;
  // Cursor NOT advanced on an incomplete pass — the same window is re-fetched
  // on a later firing (overlap, never a gap; upserts are idempotent).
  if (!delta_.complete) return { orders: [], complete: false };

  // Rebuild the full owner set from the durable cache (delta + everything older).
  const cachedRows = await readOwnerComposableCache(context, owner);
  if (expired()) return { orders: [], complete: false };

  // Re-check any still-open cached rows — long-lived orders that terminated
  // earlier would otherwise keep a stale "open" status forever.
  const reconciled = await reconcileOpenCachedRows(context, owner, cachedRows);
  if (expired()) return { orders: [], complete: false };

  // Re-map by the stable hash to the current generator id.
  const results = await remapToCurrentGenerators(context, reconciled);

  // Complete pass — the newest raw order in the delta (pages are newest-first)
  // becomes the next cursor.
  const newest = delta_.orders[0];
  if (newest) {
    const fresh = await context.OwnerDrainProgress.get(progressId);
    context.OwnerDrainProgress.set({
      id: progressId,
      owner: owner.toLowerCase(),
      nextOffset: fresh?.nextOffset ?? 0,
      complete: fresh?.complete ?? true,
      deltaCursor: BigInt(Math.floor(new Date(newest.creationDate).getTime() / 1000)),
      lastAttemptAt: fresh?.lastAttemptAt,
    });
  }

  log("info", "ob:fetchResult", { owner, chainId, since: cursor ?? null, delta: deltaCount, total: results.length, complete: true });
  return { orders: results, complete: true };
}

/**
 * Upsert composable orders into DiscreteOrder.
 * On conflict the API's authoritative status/validTo/executed overwrite the
 * existing row (other fields — incl. promotedAt — are preserved).
 *
 * Skips no-op writes: resumed drain slices and delta rebuilds re-upsert rows
 * already persisted. Without the diff every retry would bump updatedAtBlock on
 * untouched rows and their parent generators, making cursor-synced clients
 * re-fetch data that never changed. Returns the number of rows actually
 * inserted or changed, not the input size, and bumps the changed rows' parent
 * generators.
 */
export async function upsertDiscreteOrders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  orders: ComposableOrder[],
  blockNumber: bigint,
): Promise<number> {
  if (orders.length === 0) return 0;
  let changedCount = 0;
  const changedGeneratorIds: string[] = [];
  for (const order of orders) {
    const id = order.uid;
    const existing = await context.DiscreteOrder.get(id);
    if (existing) {
      const status = toDiscreteStatus(order.status);
      const validTo = order.validTo != null ? BigInt(order.validTo) : undefined;
      // Durable-cache rows from before the executedFee column carry nulls —
      // coalesce with the existing value so they never erase amounts already
      // written by a fresh fetch. The no-op diff below compares the
      // post-coalesce effective values.
      const executedSellAmount = order.executedSellAmount ?? existing.executedSellAmount ?? undefined;
      const executedBuyAmount = order.executedBuyAmount ?? existing.executedBuyAmount ?? undefined;
      const executedFee = order.executedFee ?? existing.executedFee ?? undefined;
      // Compare only the fields this upsert can change.
      if (
        existing.status === status &&
        existing.validTo === validTo &&
        existing.executedSellAmount === executedSellAmount &&
        existing.executedBuyAmount === executedBuyAmount &&
        existing.executedFee === executedFee
      ) {
        continue;
      }
      context.DiscreteOrder.set({
        ...existing,
        status,
        validTo,
        executedSellAmount,
        executedBuyAmount,
        executedFee,
        updatedAtBlock: blockNumber,
      });
    } else {
      context.DiscreteOrder.set({
        id,
        orderUid: order.uid,
        conditionalOrderGenerator_id: order.generatorId,
        status: toDiscreteStatus(order.status),
        sellAmount: order.sellAmount,
        buyAmount: order.buyAmount,
        feeAmount: order.feeAmount,
        validTo: order.validTo != null ? BigInt(order.validTo) : undefined,
        creationDate: order.creationDate,
        executedSellAmount: order.executedSellAmount ?? undefined,
        executedBuyAmount: order.executedBuyAmount ?? undefined,
        executedFee: order.executedFee ?? undefined,
        promotedAt: undefined,
        updatedAtBlock: blockNumber,
      });
    }
    changedCount++;
    changedGeneratorIds.push(order.generatorId);
  }
  await bumpGeneratorsUpdatedAt(context, changedGeneratorIds, blockNumber);
  await refreshTwapExecutedTotals(context, changedGeneratorIds);
  return changedCount;
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
  uids: string[],
): Promise<Map<string, OrderStatusInfo>> {
  const result = new Map<string, OrderStatusInfo>();
  if (uids.length === 0) return result;

  const chainId = context.chain.id;
  const apiBaseUrl = ORDERBOOK_API_URLS[chainId];
  if (!apiBaseUrl) return result;

  // Check cache first. Fulfilled entries with a null executedFee predate the
  // executedFee cache column and would otherwise stay stale forever (terminal
  // entries are never re-fetched) — treat them as misses, but keep the cached
  // data as a fallback in case the UID has aged out of /by_uids. Expired and
  // cancelled entries executed nothing, so a null fee there is left alone.
  const cached = await getCachedUidStatuses(context, uids);
  const toFetch: string[] = [];
  const staleFallbacks = new Map<string, OrderStatusInfo>();

  for (const uid of uids) {
    const cachedData = cached.get(uid);
    if (cachedData && TERMINAL_STATUSES.has(cachedData.status)) {
      const info: OrderStatusInfo = {
        status: cachedData.status,
        executedSellAmount: toBigIntOrNull(cachedData.executedSellAmount),
        executedBuyAmount: toBigIntOrNull(cachedData.executedBuyAmount),
        executedFee: toBigIntOrNull(cachedData.executedFee),
      };
      if (cachedData.status === "fulfilled" && cachedData.executedFee == null) {
        staleFallbacks.set(uid, info);
        toFetch.push(uid);
      } else {
        result.set(uid, info);
      }
    } else {
      toFetch.push(uid);
    }
  }

  // Batch-fetch non-cached UIDs (fetchOrdersByUids chunks at 50 and runs the
  // chunks in parallel under the shared HTTP semaphore), capped at 2 x the
  // per-request timeout. Terminal results are memoized in OrderUidCache below.
  if (toFetch.length > 0) {
    let fetched: OrderbookOrder[];
    try {
      fetched = await withTimeout(
        fetchOrdersByUids(context, toFetch),
        ORDERBOOK_BATCH_TIMEOUT_MS,
        "ob:statusByUids",
      );
    } catch (err) {
      if (err instanceof TimeoutError) {
        log("warn", "ob:statusByUidsTimeout", { chainId, toFetch: toFetch.length, after: ORDERBOOK_BATCH_TIMEOUT_MS });
        // Cache-only map — callers treat missing UIDs as "not on API yet".
        // Stale-but-known entries still answer from cache.
        for (const [uid, info] of staleFallbacks) result.set(uid, info);
        return result;
      }
      throw err;
    }

    const newTerminal: ComposableOrder[] = [];

    for (const order of fetched) {
      result.set(order.uid, {
        status: order.status,
        executedSellAmount: toBigIntOrNull(order.executedSellAmount),
        executedBuyAmount: toBigIntOrNull(order.executedBuyAmount),
        executedFee: toBigIntOrNull(order.executedFee),
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
          executedSellAmount: toBigIntOrNull(order.executedSellAmount),
          executedBuyAmount: toBigIntOrNull(order.executedBuyAmount),
          executedFee: toBigIntOrNull(order.executedFee),
        });
      }
    }

    if (newTerminal.length > 0) {
      await cacheUidStatuses(context, newTerminal);
    }

    // Stale UIDs the API no longer returns (aged out of /by_uids): answer with
    // the cached data rather than omitting them, so callers don't mistake a
    // long-settled order for "not on API yet".
    for (const [uid, info] of staleFallbacks) {
      if (!result.has(uid)) result.set(uid, info);
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
  owner: Hex,
  maxPages = 3,
): Promise<Map<string, OrderStatusInfo>> {
  const result = new Map<string, OrderStatusInfo>();
  const apiBaseUrl = ORDERBOOK_API_URLS[context.chain.id];
  if (!apiBaseUrl) return result;
  const { orders } = await fetchAccountOrders(context, owner, maxPages);
  for (const order of orders) {
    result.set(order.uid, {
      status: order.status,
      executedSellAmount: toBigIntOrNull(order.executedSellAmount),
      executedBuyAmount: toBigIntOrNull(order.executedBuyAmount),
      executedFee: toBigIntOrNull(order.executedFee),
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
  uids: string[],
): Promise<Map<string, FlashLoanEnrichment>> {
  const result = new Map<string, FlashLoanEnrichment>();
  if (uids.length === 0) return result;

  const chainId = context.chain.id;
  const apiBaseUrl = ORDERBOOK_API_URLS[chainId];
  if (!apiBaseUrl) return result;

  // Cache first.
  const cached = await getCachedFlashLoanEnrichment(context, uids);
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
      fetchOrdersByUids(context, toFetch),
      ORDERBOOK_BATCH_TIMEOUT_MS,
      "ob:flashLoanByUids",
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      log("warn", "ob:flashLoanByUidsTimeout", { chainId, toFetch: toFetch.length, after: ORDERBOOK_BATCH_TIMEOUT_MS });
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
    await cacheFlashLoanEnrichment(context, newlyFetched);
  }

  return result;
}
