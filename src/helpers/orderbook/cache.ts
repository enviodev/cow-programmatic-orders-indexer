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
import { log } from "../logger.js";
import { type OrderType } from "../../utils/order-types.js";
import {
  type CachedOrderData,
  type ComposableCacheRow,
  type ComposableOrder,
  type FlashLoanEnrichment,
} from "./types.js";

/** Project a freshly-decoded ComposableOrder into the durable-cache row shape. */
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
    executedSellAmount: o.executedSellAmount ?? null,
    executedBuyAmount: o.executedBuyAmount ?? null,
  };
}

const uidCacheId = (uid: string): string => `${chainId}_${uid}`;

/** Read cached flash-loan enrichment for a list of UIDs. */
export async function getCachedFlashLoanEnrichment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  uids: string[],
): Promise<Map<string, FlashLoanEnrichment>> {
  const result = new Map<string, FlashLoanEnrichment>();
  if (uids.length === 0) return result;

  const rows = await Promise.all(
    uids.map((uid) => context.OrderUidCache.get(uidCacheId(chainId, uid))),
  );
  for (const row of rows) {
    if (!row) continue;
    // Skip discrete rows that lack enrichment (kind/amounts null). In practice
    // the UID sets are disjoint, so this only guards against accidental overlap.
    if (row.kind == null || row.sellAmount == null || row.buyAmount == null) continue;
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
 * Persist flash-loan enrichment into the shared cache (terminal, so cached
 * indefinitely). status is set to "fulfilled" — flash-loan orders are settled
 * by definition. Insert-only (upstream onConflictDoNothing).
 */
export async function cacheFlashLoanEnrichment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  entries: { uid: string; enrichment: FlashLoanEnrichment }[],
): Promise<void> {
  if (entries.length === 0) return;
  const now = BigInt(Math.floor(Date.now() / 1000));
  try {
    for (const { uid, enrichment } of entries) {
      const id = uidCacheId(chainId, uid);
      const existing = await context.OrderUidCache.get(id);
      if (existing) continue; // onConflictDoNothing
      context.OrderUidCache.set({
        id,
        chainId,
        orderUid: uid,
        status: "fulfilled",
        fetchedAt: now,
        executedSellAmount: enrichment.executedSellAmount,
        executedBuyAmount: enrichment.executedBuyAmount,
        kind: enrichment.kind,
        receiver: enrichment.receiver ?? undefined,
        sellAmount: enrichment.sellAmount,
        buyAmount: enrichment.buyAmount,
      });
    }
  } catch (err) {
    log("warn", "ob:flashLoanCacheWriteFailed", { chainId, entries: entries.length, err: String(err) });
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
    uids.map((uid) => context.OrderUidCache.get(uidCacheId(chainId, uid))),
  );
  for (const row of rows) {
    if (!row) continue;
    result.set(row.orderUid, {
      status: row.status,
      executedSellAmount: row.executedSellAmount ?? null,
      executedBuyAmount: row.executedBuyAmount ?? null,
    });
  }

  return result;
}

/** Cache terminal statuses and executed amounts for composable orders (upsert). */
export async function cacheUidStatuses(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  orders: ComposableOrder[],
): Promise<void> {
  if (orders.length === 0) return;
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (const order of orders) {
    const id = uidCacheId(chainId, order.uid);
    const existing = await context.OrderUidCache.get(id);
    context.OrderUidCache.set({
      // Preserve any flash-loan enrichment columns already on the row.
      ...(existing ?? { kind: undefined, receiver: undefined, sellAmount: undefined, buyAmount: undefined }),
      id,
      chainId,
      orderUid: order.uid,
      status: order.status,
      fetchedAt: now,
      executedSellAmount: order.executedSellAmount ?? undefined,
      executedBuyAmount: order.executedBuyAmount ?? undefined,
    });
  }
}

// ─── Durable composable-order cache helpers ───────────────────────────────────

/** Newest creationDate already cached for this owner (Unix seconds), or undefined
 *  when nothing is cached — the signal to do a full-history drain. */
export async function readOwnerBackfillCursor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  owner: Hex,
): Promise<number | undefined> {
  const rows = await context.ComposableOrderCache.getWhere({
    owner: { _eq: owner.toLowerCase() },
  });
  if (rows.length === 0) return undefined;
  let max = 0n;
  for (const row of rows) {
    if (row.creationDate > max) max = row.creationDate;
  }
  return Number(max);
}

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
  }));
}

/** Upsert durable composable rows; status/validTo/executed overwrite on conflict. */
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
      context.ComposableOrderCache.set({
        id: `${chainId}_${r.orderUid}`,
        chainId,
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
        fetchedAt: now,
      });
    }
  } catch (err) {
    log("warn", "ob:composableCacheWriteFailed", { chainId, rows: rows.length, err: String(err) });
  }
}
