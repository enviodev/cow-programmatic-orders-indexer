/**
 * Durable orderbook caches — envio-entity port of the upstream cow_cache
 * Postgres schema (order_uid_cache + composable_order tables).
 *
 * Upstream keeps these outside ponder's per-deployment schema so they survive
 * redeploys. Here they are regular entities (OrderUidCache /
 * ComposableOrderCache): they survive restarts; a full re-sync rebuilds them
 * from the orderbook, same as a fresh upstream deploy.
 */

import { type Hex } from "viem";
import { CACHE_VERSION, DEFAULT_REORG_SAFETY_WINDOW_SECONDS } from "../../constants.js";
import { REORG_SAFETY_WINDOW_SECONDS } from "../../data.js";
import { log } from "../logger.js";
import { classifyCachedRow } from "./trust.js";
import { type OrderType } from "../../utils/order-types.js";
import {
  type CachedOrderData,
  type ComposableCacheRow,
  type ComposableOrder,
  type FlashLoanEnrichment,
} from "./types.js";

/** Project a freshly-decoded ComposableOrder into the durable-cache row shape.
 *  The cache entities store amounts as String — bigints convert at this boundary. */
export function toCacheRow(o: ComposableOrder): ComposableCacheRow {
  return {
    orderUid: o.uid,
    generatorHash: o.generatorHash,
    orderType: o.orderType,
    status: o.status,
    sellAmount: o.sellAmount,
    buyAmount: o.buyAmount,
    feeAmount: o.feeAmount,
    validTo: o.validTo ?? null,
    creationDate: o.creationDate,
    executedSellAmount: o.executedSellAmount?.toString() ?? null,
    executedBuyAmount: o.executedBuyAmount?.toString() ?? null,
    executedFee: o.executedFee?.toString() ?? null,
  };
}

// Entity ids are the bare orderUid — envio keys rows by (id, chainId) under
// disable_default_cross_chain, so the old `${chainId}_` prefix is redundant.

/** Read cached flash-loan enrichment for a list of UIDs. Only rows the trust
 *  rule considers final are served — soft rows (recently settled, or written
 *  by an older cache version) fall through to a fresh fetch that re-caches. */
export async function getCachedFlashLoanEnrichment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  uids: string[],
): Promise<Map<string, FlashLoanEnrichment>> {
  const result = new Map<string, FlashLoanEnrichment>();
  if (uids.length === 0) return result;
  const window =
    REORG_SAFETY_WINDOW_SECONDS[context.chain.id] ?? DEFAULT_REORG_SAFETY_WINDOW_SECONDS;
  const now = Math.floor(Date.now() / 1000);

  const rows = await Promise.all(
    uids.map((uid) => context.OrderUidCache.get(uid)),
  );
  for (const row of rows) {
    if (!row) continue;
    // Skip discrete rows that lack enrichment (kind/amounts null). In practice
    // the UID sets are disjoint, so this only guards against accidental overlap.
    if (row.kind == null || row.sellAmount == null || row.buyAmount == null) continue;
    if (classifyCachedRow(toTrustInputs(row), now, window) !== "trusted") continue;
    result.set(row.orderUid, {
      receiver: row.receiver ?? null,
      kind: row.kind as "sell" | "buy",
      sellAmount: row.sellAmount,
      buyAmount: row.buyAmount,
      executedSellAmount: row.executedSellAmount ?? "0",
      executedBuyAmount: row.executedBuyAmount ?? "0",
    });
  }

  return result;
}

/**
 * Persist flash-loan enrichment into the shared cache. status is set to
 * "fulfilled" — flash-loan orders are settled by definition.
 * Upsert (not insert-only): soft rows are re-fetched until the trust rule
 * hardens them, and each re-fetch must advance fetchedAt (the cooling-off
 * anchor) and refresh amounts a reorg may have changed. terminalSince
 * survives same-status re-fetches so the cooling-off clock isn't reset.
 */
export async function cacheFlashLoanEnrichment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  entries: { uid: string; enrichment: FlashLoanEnrichment; validTo: number | null }[],
): Promise<void> {
  if (entries.length === 0) return;
  const now = BigInt(Math.floor(Date.now() / 1000));
  try {
    for (const { uid, enrichment, validTo } of entries) {
      const existing = await context.OrderUidCache.get(uid);
      context.OrderUidCache.set({
        ...(existing ?? {}),
        id: uid,
        orderUid: uid,
        status: "fulfilled",
        fetchedAt: now,
        executedSellAmount: enrichment.executedSellAmount,
        executedBuyAmount: enrichment.executedBuyAmount,
        kind: existing?.kind ?? enrichment.kind,
        receiver: existing?.receiver ?? enrichment.receiver ?? undefined,
        sellAmount: existing?.sellAmount ?? enrichment.sellAmount,
        buyAmount: existing?.buyAmount ?? enrichment.buyAmount,
        validTo: validTo != null ? BigInt(validTo) : existing?.validTo,
        terminalSince:
          existing && existing.status === "fulfilled" && existing.terminalSince != null
            ? existing.terminalSince
            : now,
        cacheVersion: CACHE_VERSION,
      });
    }
  } catch (err) {
    log("warn", "ob:flashLoanCacheWriteFailed", { chainId: context.chain.id, entries: entries.length, err: String(err) });
  }
}

/** Get cached data for a list of UIDs. Returns a Map of uid -> CachedOrderData. */
export async function getCachedUidStatuses(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  uids: string[],
): Promise<Map<string, CachedOrderData>> {
  const result = new Map<string, CachedOrderData>();
  if (uids.length === 0) return result;

  const rows = await Promise.all(
    uids.map((uid) => context.OrderUidCache.get(uid)),
  );
  for (const row of rows) {
    if (!row) continue;
    result.set(row.orderUid, {
      status: row.status,
      executedSellAmount: row.executedSellAmount ?? null,
      executedBuyAmount: row.executedBuyAmount ?? null,
      executedFee: row.executedFee ?? null,
      validTo: row.validTo != null ? Number(row.validTo) : null,
      terminalSince: row.terminalSince != null ? Number(row.terminalSince) : null,
      fetchedAt: row.fetchedAt != null ? Number(row.fetchedAt) : null,
      cacheVersion: row.cacheVersion ?? null,
    });
  }

  return result;
}

/** Cache terminal statuses and executed amounts for composable orders (upsert).
 *  terminalSince survives same-status re-fetches (it anchors the cooling-off
 *  rule in trust.ts) and resets when the status actually changed. */
export async function cacheUidStatuses(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  orders: ComposableOrder[],
): Promise<void> {
  if (orders.length === 0) return;
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (const order of orders) {
    const existing = await context.OrderUidCache.get(order.uid);
    context.OrderUidCache.set({
      // Preserve any flash-loan enrichment columns already on the row.
      ...(existing ?? { kind: undefined, receiver: undefined, sellAmount: undefined, buyAmount: undefined }),
      id: order.uid,
      orderUid: order.uid,
      status: order.status,
      fetchedAt: now,
      executedSellAmount: order.executedSellAmount?.toString() ?? undefined,
      executedBuyAmount: order.executedBuyAmount?.toString() ?? undefined,
      executedFee: order.executedFee?.toString() ?? undefined,
      validTo: order.validTo != null ? BigInt(order.validTo) : undefined,
      terminalSince:
        existing && existing.status === order.status && existing.terminalSince != null
          ? existing.terminalSince
          : now,
      cacheVersion: CACHE_VERSION,
    });
  }
}

/** Drop cache rows whose terminal status a fresh fetch just contradicted
 *  (reorg revert: the API says the order is open again). The next fetch
 *  re-caches whatever the API settles on. */
export async function deleteUidCacheEntries(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  uids: string[],
): Promise<void> {
  if (uids.length === 0) return;
  for (const uid of uids) {
    context.OrderUidCache.deleteUnsafe(uid);
  }
  log("info", "ob:cacheRevert", { chainId: context.chain.id, uids: uids.length });
}

/** Map an OrderUidCache entity row into trust.ts inputs (bigint -> number). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toTrustInputs(row: any): {
  status: string;
  validTo: number | null;
  terminalSince: number | null;
  fetchedAt: number | null;
  cacheVersion: number | null;
} {
  return {
    status: row.status,
    validTo: row.validTo != null ? Number(row.validTo) : null,
    terminalSince: row.terminalSince != null ? Number(row.terminalSince) : null,
    fetchedAt: row.fetchedAt != null ? Number(row.fetchedAt) : null,
    cacheVersion: row.cacheVersion ?? null,
  };
}

// ─── Durable composable-order cache helpers ───────────────────────────────────
// The delta cursor lives on OwnerDrainProgress (explicit, upstream owner_drain
// semantics) — it is never derived from MAX(creationDate) over these rows.

/** All durably-cached composable rows for an owner. */
export async function readOwnerComposableCache(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  owner: Hex,
): Promise<ComposableCacheRow[]> {
  const rows = await context.ComposableOrderCache.getWhere({
    owner: { _eq: owner.toLowerCase() },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.map((row: any) => ({
    orderUid: row.orderUid,
    generatorHash: row.generatorHash,
    orderType: row.orderType as OrderType,
    status: row.status,
    sellAmount: row.sellAmount,
    buyAmount: row.buyAmount,
    feeAmount: row.feeAmount,
    validTo: row.validTo != null ? Number(row.validTo) : null,
    creationDate: row.creationDate,
    executedSellAmount: row.executedSellAmount ?? null,
    executedBuyAmount: row.executedBuyAmount ?? null,
    executedFee: row.executedFee ?? null,
    terminalSince: row.terminalSince != null ? Number(row.terminalSince) : null,
    fetchedAt: row.fetchedAt != null ? Number(row.fetchedAt) : null,
    cacheVersion: row.cacheVersion ?? null,
  }));
}

/** Upsert durable composable rows; status/validTo/executed overwrite on conflict.
 *  terminalSince survives same-status re-writes (trust.ts cooling-off anchor). */
export async function upsertComposableCache(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  owner: Hex,
  rows: ComposableCacheRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const now = BigInt(Math.floor(Date.now() / 1000));
  try {
    for (const r of rows) {
      const existing = await context.ComposableOrderCache.get(r.orderUid);
      const isTerminal = r.status === "fulfilled" || r.status === "expired" || r.status === "cancelled";
      context.ComposableOrderCache.set({
        id: r.orderUid,
        orderUid: r.orderUid,
        owner: owner.toLowerCase(),
        generatorHash: r.generatorHash,
        orderType: r.orderType,
        status: r.status,
        sellAmount: r.sellAmount,
        buyAmount: r.buyAmount,
        feeAmount: r.feeAmount,
        validTo: r.validTo != null ? BigInt(r.validTo) : undefined,
        creationDate: r.creationDate,
        executedSellAmount: r.executedSellAmount ?? undefined,
        executedBuyAmount: r.executedBuyAmount ?? undefined,
        executedFee: r.executedFee ?? undefined,
        fetchedAt: now,
        terminalSince: !isTerminal
          ? undefined
          : existing && existing.status === r.status && existing.terminalSince != null
            ? existing.terminalSince
            : now,
        cacheVersion: CACHE_VERSION,
      });
    }
  } catch (err) {
    log("warn", "ob:composableCacheWriteFailed", { chainId: context.chain.id, rows: rows.length, err: String(err) });
  }
}
