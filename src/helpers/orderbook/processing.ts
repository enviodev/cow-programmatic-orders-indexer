/**
 * Orderbook order processing — filter API orders to composable EIP-1271,
 * decode signatures, match to generators. Ported from the upstream ponder
 * indexer's orderbook/processing.ts (raw SQL replaced with entity getWhere).
 */

import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { type OrderType } from "../../utils/order-types.js";
import { COMPOSABLE_COW_HANDLER_ADDRESSES, REORG_SAFETY_WINDOW_SECONDS } from "../../data.js";
import { DEFAULT_REORG_SAFETY_WINDOW_SECONDS, SIGNING_SCHEME_EIP1271 } from "../../constants.js";
import { classifyCachedRow } from "./trust.js";
import { decodeEip1271Signature } from "../../decoders/erc1271-signature.js";
import { fetchOrdersByUids } from "./http.js";
import { upsertComposableCache } from "./cache.js";
import {
  TERMINAL_STATUSES,
  toBigIntOrNull,
  type ComposableCacheRow,
  type ComposableOrder,
  type OrderbookOrder,
} from "./types.js";

// ─── Processing ──────────────────────────────────────────────────────────────

/** Filter API orders to composable eip1271, decode signatures, match to generators. */
export async function filterAndProcess(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  apiOrders: OrderbookOrder[],
): Promise<ComposableOrder[]> {
  // First pass: decode signatures and compute param hashes. Thousands of a
  // whale's orders map to a handful of generators, so dedupe hashes and match
  // them with one _in query instead of one getWhere per order.
  const decodedOrders: { order: OrderbookOrder; paramHash: string }[] = [];

  for (const order of apiOrders) {
    if (order.signingScheme !== SIGNING_SCHEME_EIP1271) continue;
    if (order.status === "presignaturePending") continue;

    const decoded = decodeEip1271Signature(order.signature as Hex);
    if (!decoded) continue;

    if (!COMPOSABLE_COW_HANDLER_ADDRESSES.has(decoded.handler)) continue;

    // Reproduce the same hash stored in ConditionalOrderGenerator.hash
    const paramHash = keccak256(
      encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { name: "handler", type: "address" },
              { name: "salt", type: "bytes32" },
              { name: "staticInput", type: "bytes" },
            ],
          },
        ],
        [{ handler: decoded.handler, salt: decoded.salt, staticInput: decoded.staticInput }],
      ),
    );

    decodedOrders.push({ order, paramHash });
  }

  if (decodedOrders.length === 0) return [];

  // Find the generators — exactly one per (chainId, hash).
  const uniqueHashes = [...new Set(decodedOrders.map((d) => d.paramHash))];
  const generators = await context.ConditionalOrderGenerator.getWhere({
    hash: { _in: uniqueHashes },
  });
  const generatorByHash = new Map<string, { id: string; orderType: string }>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generators.map((g: any) => [g.hash, g]),
  );

  const results: ComposableOrder[] = [];
  for (const { order, paramHash } of decodedOrders) {
    const generator = generatorByHash.get(paramHash);
    if (!generator) continue;

    results.push({
      uid: order.uid,
      status: order.status,
      generatorId: generator.id,
      generatorHash: paramHash,
      orderType: generator.orderType as OrderType,
      sellAmount: order.sellAmount,
      buyAmount: order.buyAmount,
      feeAmount: order.feeAmount,
      validTo: order.validTo,
      creationDate: BigInt(Math.floor(new Date(order.creationDate).getTime() / 1000)),
      executedSellAmount: toBigIntOrNull(order.executedSellAmount),
      executedBuyAmount: toBigIntOrNull(order.executedBuyAmount),
      executedFee: toBigIntOrNull(order.executedFee),
    });
  }

  return results;
}

/** Re-check cached rows the trust rule doesn't consider final (open rows, and
 *  terminal rows still inside the chain's reorg window or written by an older
 *  cache version — see trust.ts) via by_uids; update status/validTo/executed
 *  and re-persist every row the fetch touched, including terminal statuses a
 *  reorg reverted back to open. Mutates and returns `rows`. */
export async function reconcileOpenCachedRows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  owner: Hex,
  rows: ComposableCacheRow[],
): Promise<ComposableCacheRow[]> {
  const window =
    REORG_SAFETY_WINDOW_SECONDS[context.chain.id] ?? DEFAULT_REORG_SAFETY_WINDOW_SECONDS;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const staleUids = rows
    .filter((r) =>
      classifyCachedRow(
        {
          status: r.status,
          validTo: r.validTo,
          terminalSince: r.terminalSince ?? null,
          fetchedAt: r.fetchedAt ?? null,
          cacheVersion: r.cacheVersion ?? null,
        },
        nowSeconds,
        window,
      ) !== "trusted",
    )
    .map((r) => r.orderUid);
  if (staleUids.length === 0) return rows;

  const refreshed = await fetchOrdersByUids(context, staleUids);
  if (refreshed.length === 0) return rows;
  const byUid = new Map(refreshed.map((o) => [o.uid, o]));

  const touched: ComposableCacheRow[] = [];
  for (const row of rows) {
    const fresh = byUid.get(row.orderUid);
    if (!fresh) continue;
    row.status = fresh.status;
    row.validTo = fresh.validTo;
    row.executedSellAmount = fresh.executedSellAmount;
    row.executedBuyAmount = fresh.executedBuyAmount;
    row.executedFee = fresh.executedFee;
    touched.push(row);
  }

  if (touched.length > 0) {
    await upsertComposableCache(context, owner, touched);
  }
  return rows;
}

/** Map durable rows (keyed by the stable generatorHash) to ComposableOrder with the
 *  current generator id. Rows with no current generator are dropped. */
export async function remapToCurrentGenerators(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  rows: ComposableCacheRow[],
): Promise<ComposableOrder[]> {
  if (rows.length === 0) return [];
  const hashes = [...new Set(rows.map((r) => r.generatorHash))];

  const generators = await context.ConditionalOrderGenerator.getWhere({
    hash: { _in: hashes },
  });

  const idByHash = new Map<string, string>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generators.map((g: any) => [g.hash, g.id]),
  );

  const results: ComposableOrder[] = [];
  for (const row of rows) {
    const generatorId = idByHash.get(row.generatorHash);
    if (!generatorId) continue;
    results.push({
      uid: row.orderUid,
      status: row.status,
      generatorId,
      generatorHash: row.generatorHash,
      orderType: row.orderType,
      sellAmount: row.sellAmount,
      buyAmount: row.buyAmount,
      feeAmount: row.feeAmount,
      validTo: row.validTo,
      creationDate: row.creationDate,
      executedSellAmount: toBigIntOrNull(row.executedSellAmount),
      executedBuyAmount: toBigIntOrNull(row.executedBuyAmount),
      executedFee: toBigIntOrNull(row.executedFee),
    });
  }
  return results;
}

/** Match slim pre-decoded history rows (from the cached history-page effect)
 *  to generators — the DB half of filterAndProcess. One _in query per batch. */
export async function matchHistoryRowsToGenerators(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  rows: import("../../effects/orderbook.js").HistoryPageRow[],
): Promise<ComposableOrder[]> {
  if (rows.length === 0) return [];

  const uniqueHashes = [...new Set(rows.map((r) => r.paramHash))];
  const generators = await context.ConditionalOrderGenerator.getWhere({
    hash: { _in: uniqueHashes },
  });
  const generatorByHash = new Map<string, { id: string; orderType: string }>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generators.map((g: any) => [g.hash, g]),
  );

  const results: ComposableOrder[] = [];
  for (const row of rows) {
    const generator = generatorByHash.get(row.paramHash);
    if (!generator) continue;
    results.push({
      uid: row.uid,
      status: row.status,
      generatorId: generator.id,
      generatorHash: row.paramHash,
      orderType: generator.orderType as OrderType,
      sellAmount: row.sellAmount,
      buyAmount: row.buyAmount,
      feeAmount: row.feeAmount,
      validTo: row.validTo,
      creationDate: BigInt(row.creationDate),
      executedSellAmount: toBigIntOrNull(row.executedSellAmount),
      executedBuyAmount: toBigIntOrNull(row.executedBuyAmount),
      executedFee: toBigIntOrNull(row.executedFee),
    });
  }
  return results;
}
