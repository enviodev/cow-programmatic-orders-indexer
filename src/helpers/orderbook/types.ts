import { type OrderType } from "../../utils/order-types.js";

// ─── Types ───────────────────────────────────────────────────────────────────
// Ported from the upstream ponder indexer's orderbook/types.ts, decoupled from
// the ponder schema types.

/** Raw API response shape (subset of fields we use). */
export interface OrderbookOrder {
  uid: string;
  status: "open" | "fulfilled" | "expired" | "cancelled" | "presignaturePending";
  kind: "sell" | "buy";
  receiver: string | null;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  validTo: number;
  creationDate: string; // ISO 8601
  signingScheme: string;
  signature: string;
  executedSellAmount: string;
  executedBuyAmount: string;
  executedFee: string;
}

/** DiscreteOrder.status enum values (capitalized — lowercase "open" is reserved in envio schemas). */
export type DiscreteStatus = "Open" | "Fulfilled" | "Unfilled" | "Expired" | "Cancelled";

/** Map an orderbook API status (lowercase) to the DiscreteOrderStatus enum value. */
export function toDiscreteStatus(apiStatus: string): DiscreteStatus {
  switch (apiStatus) {
    case "open": return "Open";
    case "fulfilled": return "Fulfilled";
    case "unfilled": return "Unfilled";
    case "expired": return "Expired";
    case "cancelled": return "Cancelled";
    default: return "Open";
  }
}

/** Processed composable order stored in cache and returned to callers. */
export interface ComposableOrder {
  uid: string;
  status: string; // API status (lowercase)
  generatorId: string;
  generatorHash: string;
  orderType: OrderType;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  validTo: number | null;
  creationDate: bigint;
  executedSellAmount: bigint | null;
  executedBuyAmount: bigint | null;
  executedFee: bigint | null;
}

/** Status + executed amounts returned by fetchOrderStatusByUids.
 *  Amounts are bigint (matching the DiscreteOrder columns); null when the
 *  cached entry predates the executed columns. */
export interface OrderStatusInfo {
  status: string;
  executedSellAmount: bigint | null;
  executedBuyAmount: bigint | null;
  executedFee: bigint | null;
}

/** API/cache decimal string -> bigint at the storage boundary. */
export function toBigIntOrNull(value: string | null | undefined): bigint | null {
  return value == null ? null : BigInt(value);
}

/** CoW-order fields used to enrich a flash-loan order, from the orderbook. */
export interface FlashLoanEnrichment {
  receiver: string | null;
  kind: "sell" | "buy";
  sellAmount: string;
  buyAmount: string;
  executedSellAmount: string;
  executedBuyAmount: string;
}

/** Durable-cache row shape for ComposableOrderCache (owner passed separately). */
export interface ComposableCacheRow {
  orderUid: string;
  generatorHash: string;
  orderType: OrderType;
  status: string;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  validTo: number | null;
  creationDate: bigint;
  executedSellAmount: string | null;
  executedBuyAmount: string | null;
  executedFee: string | null;
  /** Read-side trust fields (see trust.ts) — absent on freshly-decoded rows. */
  terminalSince?: number | null;
  fetchedAt?: number | null;
  cacheVersion?: number | null;
}

/** Cached order data returned by getCachedUidStatuses. */
export interface CachedOrderData {
  status: string;
  executedSellAmount: string | null;
  executedBuyAmount: string | null;
  executedFee: string | null;
  validTo: number | null;
  terminalSince: number | null;
  fetchedAt: number | null;
  cacheVersion: number | null;
}

export const TERMINAL_STATUSES = new Set(["fulfilled", "expired", "cancelled"]);
export const PAGE_LIMIT = 1000;
// Empirically verified against api.cow.fi: 100 UIDs per by_uids POST is the
// maximum (200 returns HTTP 413). Bigger batches halve the request count.
export const BATCH_SIZE = 100;
