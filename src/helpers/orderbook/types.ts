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
  executedSellAmount: string | null;
  executedBuyAmount: string | null;
}

/** Status + executed amounts returned by fetchOrderStatusByUids. */
export interface OrderStatusInfo {
  status: string;
  executedSellAmount: string | null; // null when served from cache
  executedBuyAmount: string | null;
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
}

/** Cached order data returned by getCachedUidStatuses. */
export interface CachedOrderData {
  status: string;
  executedSellAmount: string | null;
  executedBuyAmount: string | null;
}

export const TERMINAL_STATUSES = new Set(["fulfilled", "expired", "cancelled"]);
export const PAGE_LIMIT = 1000;
// Empirically verified against api.cow.fi: 100 UIDs per by_uids POST is the
// maximum (200 returns HTTP 413). Bigger batches halve the request count.
export const BATCH_SIZE = 100;
