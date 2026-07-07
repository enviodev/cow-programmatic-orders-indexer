/**
 * Orderbook order processing — filter API orders to composable EIP-1271,
 * decode signatures, match to generators. Ported from the upstream ponder
 * indexer's orderbook/processing.ts (raw SQL replaced with entity getWhere).
 */

import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { type OrderType } from "../../utils/order-types.js";
import { COMPOSABLE_COW_HANDLER_ADDRESSES } from "../../data.js";
import { SIGNING_SCHEME_EIP1271 } from "../../constants.js";
import { decodeEip1271Signature } from "../../decoders/erc1271-signature.js";
import { fetchOrdersByUids } from "./http.js";
import { upsertComposableCache } from "./cache.js";
import {
  TERMINAL_STATUSES,
  type ComposableCacheRow,
  type ComposableOrder,
  type OrderbookOrder,
} from "./types.js";

// ─── Processing ──────────────────────────────────────────────────────────────

/** Filter API orders to composable eip1271, decode signatures, match to generators. */
export async function filterAndProcess(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
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
    chainId: { _eq: chainId },
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
      executedSellAmount: order.executedSellAmount,
      executedBuyAmount: order.executedBuyAmount,
    });
  }

  return results;
}

/** Re-check non-terminal cached rows via by_uids; update status/validTo/executed and
 *  re-persist any that became terminal. Mutates and returns `rows`. */
export async function reconcileOpenCachedRows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  owner: Hex,
  rows: ComposableCacheRow[],
): Promise<ComposableCacheRow[]> {
  const openUids = rows.filter((r) => !TERMINAL_STATUSES.has(r.status)).map((r) => r.orderUid);
  if (openUids.length === 0) return rows;

  const refreshed = await fetchOrdersByUids(context, chainId, openUids);
  if (refreshed.length === 0) return rows;
  const byUid = new Map(refreshed.map((o) => [o.uid, o]));

  const newlyTerminal: ComposableCacheRow[] = [];
  for (const row of rows) {
    const fresh = byUid.get(row.orderUid);
    if (!fresh) continue;
    row.status = fresh.status;
    row.validTo = fresh.validTo;
    row.executedSellAmount = fresh.executedSellAmount;
    row.executedBuyAmount = fresh.executedBuyAmount;
    if (TERMINAL_STATUSES.has(fresh.status)) newlyTerminal.push(row);
  }

  if (newlyTerminal.length > 0) {
    await upsertComposableCache(context, chainId, owner, newlyTerminal);
  }
  return rows;
}

/** Map durable rows (keyed by the stable generatorHash) to ComposableOrder with the
 *  current generator id. Rows with no current generator are dropped. */
export async function remapToCurrentGenerators(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  rows: ComposableCacheRow[],
): Promise<ComposableOrder[]> {
  if (rows.length === 0) return [];
  const hashes = [...new Set(rows.map((r) => r.generatorHash))];

  const generators = await context.ConditionalOrderGenerator.getWhere({
    chainId: { _eq: chainId },
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
      executedSellAmount: row.executedSellAmount,
      executedBuyAmount: row.executedBuyAmount,
    });
  }
  return results;
}
