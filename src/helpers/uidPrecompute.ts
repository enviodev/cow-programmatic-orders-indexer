/**
 * UID pre-computation for deterministic order types.
 * Ported 1:1 from the upstream ponder indexer's helpers/uidPrecompute.ts.
 *
 * Computes discrete order UIDs at creation time from staticInput params,
 * without calling getTradeableOrderWithSignature on-chain.
 *
 * Supported order types:
 *   - TWAP: all N part UIDs computable (given t0 or block.timestamp for t0=0)
 *   - StopLoss: single UID computable (order data is fully in staticInput)
 *   - CirclesBackingOrder: single UID computable (staticInput + handler immutables; receiver=owner)
 *
 * Reference: composable-cow/src/types/twap/TWAP.sol, StopLoss.sol, circles-lbp/CirclesBackingOrder.sol
 */

import { isHex, type Hex } from "viem";
import { computeOrderUid, type GPv2OrderData, KIND_SELL, KIND_BUY, BALANCE_ERC20 } from "./orderUid.js";
import { fetchOrderStatusByUids } from "./orderbook/client.js";
import { refreshTwapExecutionState } from "./executedAmounts.js";
import { toDiscreteStatus, type OrderStatusInfo } from "./orderbook/types.js";
import { type OrderType, DETERMINISTIC_ORDER_TYPE } from "../utils/order-types.js";
import { decodeStaticInput, type DecodedOrder } from "../decoders/index.js";
import type { TwapDecodedParams } from "../decoders/twap.js";
import type { StopLossDecodedParams } from "../decoders/stop-loss.js";
import type { CirclesBackingOrderDecodedParams } from "../decoders/circles-backing-order.js";
import { log } from "./logger.js";
import { MAX_TWAP_PRECOMPUTE_PARTS } from "../constants.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** CirclesBackingOrder params merged with the handler's constructor immutables. */
export type EnrichedCirclesDecodedParams = CirclesBackingOrderDecodedParams & {
  sellToken: Hex;
  sellAmount: bigint;
};

/**
 * A generator's order type paired with its NATIVE decoded params (bigint,
 * boolean, number). Precompute must hash native values: the stored JSON form
 * stringifies bigints, and comparing its booleans against "true" silently
 * turned every StopLoss sell order into a buy order (upstream 9db52cd).
 */
export type GeneratorDecodedOrder =
  | Exclude<DecodedOrder, { orderType: "CirclesBackingOrder" }>
  | { orderType: "CirclesBackingOrder"; decodedParams: EnrichedCirclesDecodedParams }
  | { orderType: OrderType; decodedParams: null };

export interface PrecomputedOrder {
  orderUid: string;
  validTo: number;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  possibleValidAfterTimestamp: number | null; // TWAP: t0 + partIndex * t
}

// ─── Decoded-order helpers ──────────────────────────────────────────────────

/** Storage form of decoded params: bigints become decimal strings, the rest is kept. */
export function serializeDecodedParams(
  decodedParams: object | null,
): Record<string, unknown> | null {
  if (!decodedParams) return null;
  return Object.fromEntries(
    Object.entries(decodedParams).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]),
  );
}

/**
 * Rebuild a generator's native decoded order from its stored row, for the
 * deferred precompute path (PrecomputeBackfiller). The staticInput is decoded
 * again rather than parsing the stored JSON, so both paths hash identical
 * values. Stored decodedParams supply what staticInput lacks: whether decoding
 * succeeded at creation, and the CirclesBackingOrder handler immutables.
 *
 * @param creationTimestamp - creation block timestamp; resolves TWAP t0 = 0
 */
export function decodedOrderFromGenerator(
  gen: { orderType: string; staticInput: string; decodedParams?: unknown },
  creationTimestamp: bigint,
): GeneratorDecodedOrder {
  const orderType = gen.orderType as OrderType;
  const stored = (gen.decodedParams ?? null) as Record<string, unknown> | null;
  if (!stored || !isHex(gen.staticInput)) return { orderType, decodedParams: null };

  let decoded: DecodedOrder | null;
  try {
    decoded = decodeStaticInput(orderType, gen.staticInput);
  } catch {
    return { orderType, decodedParams: null };
  }
  if (!decoded) return { orderType, decodedParams: null };

  if (decoded.orderType === "TWAP" && decoded.decodedParams.t0 === 0n) {
    decoded.decodedParams.t0 = creationTimestamp;
  }
  if (decoded.orderType === "CirclesBackingOrder") {
    const { sellToken, sellAmount } = stored;
    if (typeof sellToken !== "string" || !isHex(sellToken) || typeof sellAmount !== "string") {
      return { orderType, decodedParams: null };
    }
    return {
      orderType: decoded.orderType,
      decodedParams: { ...decoded.decodedParams, sellToken, sellAmount: BigInt(sellAmount) },
    };
  }
  return decoded;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Pre-compute UIDs for a generator based on its order type and decoded params.
 * Returns an array of pre-computed orders (one for StopLoss, N for TWAP).
 * Returns null if the order type is not deterministic or params are missing.
 */
export function precomputeOrderUids(
  chainId: number,
  owner: Hex,
  decodedOrder: GeneratorDecodedOrder,
  blockTimestamp: bigint,
): PrecomputedOrder[] | null {
  if (!decodedOrder.decodedParams) {
    if (DETERMINISTIC_ORDER_TYPE[decodedOrder.orderType]) {
      log("warn", "precompute:skip", { orderType: decodedOrder.orderType, owner, chainId, reason: "decodedParams_null" });
    }
    return null;
  }

  switch (decodedOrder.orderType) {
    case "TWAP":
      return precomputeTwapUids(chainId, owner, decodedOrder.decodedParams, blockTimestamp);
    case "StopLoss":
      return precomputeStopLossUid(chainId, owner, decodedOrder.decodedParams);
    case "CirclesBackingOrder":
      return precomputeCirclesBackingOrderUid(chainId, owner, decodedOrder.decodedParams);
    default:
      // PerpetualSwap, GoodAfterTime, TradeAboveThreshold — not deterministic
      return null;
  }
}

/**
 * Pre-compute UIDs, fetch their status from the API, upsert discrete orders,
 * and deactivate the generator if all orders are terminal.
 *
 * Returns true if the generator was deactivated (all orders terminal).
 *
 * `prefetched` lets a caller handling many generators fetch every status in
 * one batched lookup (PrecomputeBackfiller) instead of one request each.
 */
export async function precomputeAndDiscover(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  generatorId: string,
  owner: Hex,
  decodedOrder: GeneratorDecodedOrder,
  blockTimestamp: bigint,
  blockNumber: bigint,
  prefetched?: Map<string, OrderStatusInfo>,
): Promise<boolean> {
  const chainId = context.chain.id;
  const precomputed = precomputeOrderUids(chainId, owner, decodedOrder, blockTimestamp);
  if (!precomputed || precomputed.length === 0) return false;

  const uids = precomputed.map((o) => o.orderUid);
  const statuses = prefetched ?? await fetchOrderStatusByUids(context, uids, "UidPrecompute");

  let wroteDiscrete = false;
  for (const order of precomputed) {
    const statusInfo = statuses.get(order.orderUid);
    const apiStatus = statusInfo?.status as
      "open" | "fulfilled" | "unfilled" | "expired" | "cancelled" | undefined;

    if (apiStatus) {
      // Known on the API → DiscreteOrder (upsert: status/validTo overwrite)
      const id = order.orderUid;
      const existing = await context.DiscreteOrder.get(id);
      if (existing) {
        context.DiscreteOrder.set({
          ...existing,
          status: toDiscreteStatus(apiStatus),
          validTo: BigInt(order.validTo),
          // Status lookups can be served from the cache with null executed
          // amounts — never let a cached null erase values already written by
          // OrderStatusTracker or OwnerBackfill (upstream coalesce).
          executedSellAmount: statusInfo?.executedSellAmount ?? existing.executedSellAmount,
          executedBuyAmount: statusInfo?.executedBuyAmount ?? existing.executedBuyAmount,
          executedFee: statusInfo?.executedFee ?? existing.executedFee,
          updatedAtBlock: blockNumber,
        });
      } else {
        context.DiscreteOrder.set({
          id,
          orderUid: order.orderUid,
          conditionalOrderGenerator_id: generatorId,
          status: toDiscreteStatus(apiStatus),
          sellAmount: order.sellAmount,
          buyAmount: order.buyAmount,
          feeAmount: order.feeAmount,
          validTo: BigInt(order.validTo),
          creationDate: blockTimestamp,
          executedSellAmount: statusInfo?.executedSellAmount ?? undefined,
          executedBuyAmount: statusInfo?.executedBuyAmount ?? undefined,
          executedFee: statusInfo?.executedFee ?? undefined,
          promotedAt: undefined,
          updatedAtBlock: blockNumber,
        });
      }
      wroteDiscrete = true;
    } else {
      // Not on the API yet → CandidateDiscreteOrder (insert-only)
      const id = order.orderUid;
      const existing = await context.CandidateDiscreteOrder.get(id);
      if (!existing) {
        context.CandidateDiscreteOrder.set({
          id,
          orderUid: order.orderUid,
          conditionalOrderGenerator_id: generatorId,
          possibleValidAfterTimestamp: order.possibleValidAfterTimestamp != null
            ? BigInt(order.possibleValidAfterTimestamp)
            : undefined,
          sellAmount: order.sellAmount,
          buyAmount: order.buyAmount,
          feeAmount: order.feeAmount,
          validTo: BigInt(order.validTo),
          creationDate: blockTimestamp,
        });
      }
    }
  }

  if (wroteDiscrete) {
    await refreshTwapExecutionState(context, [generatorId], blockNumber);
  }

  const allTerminal = precomputed.every((o) => {
    const s = statuses.get(o.orderUid)?.status;
    return s === "fulfilled" || s === "expired" || s === "cancelled";
  });

  const generator = await context.ConditionalOrderGenerator.get(generatorId);

  if (allTerminal) {
    if (generator) {
      context.ConditionalOrderGenerator.set({
        ...generator,
        status: "Completed",
        allCandidatesKnown: true,
        lastPollResult: "precompute:allTerminal",
        updatedAtBlock: blockNumber,
      });
    }
    log("info", "precompute:allTerminal", { count: precomputed.length, generatorId });
    return true;
  }

  // UIDs are fully known even though some orders are still open —
  // OrderDiscoveryPoller can skip this generator, OrderStatusTracker tracks the
  // open orders. Standalone allCandidatesKnown flips do NOT bump updatedAtBlock.
  if (generator) {
    context.ConditionalOrderGenerator.set({
      ...generator,
      allCandidatesKnown: true,
    });
  }

  return false;
}

function requireHex(value: string): Hex {
  if (!isHex(value)) throw new Error("Expected a decoded hex value");
  return value;
}

// ─── TWAP ────────────────────────────────────────────────────────────────────

/**
 * Compute all N TWAP part UIDs.
 *
 * TWAP contract logic (TWAPOrder.sol):
 *   - Each part has identical sellAmount (partSellAmount) and buyAmount (minPartLimit)
 *   - validTo = t0 + (partIndex + 1) * t - 1        (when span = 0)
 *   - validTo = t0 + partIndex * t + span - 1        (when span > 0)
 *   - feeAmount = 0, kind = SELL, partiallyFillable = false
 *   - sellTokenBalance = buyTokenBalance = ERC20
 *
 * When t0 = 0 in staticInput, the contract reads block.timestamp at creation
 * time from composableCow.cabinet(owner, ctx). We use event.block.timestamp.
 */
function precomputeTwapUids(
  chainId: number,
  owner: Hex,
  params: TwapDecodedParams,
  blockTimestamp: bigint,
): PrecomputedOrder[] | null {
  const { sellToken, buyToken, receiver, partSellAmount, minPartLimit, t0: startTime, n, t, span, appData } = params;
  const nParts = Number(n);
  const tSeconds = t;
  const spanSeconds = span;
  // When t0 = 0, the contract uses block.timestamp at creation
  const t0 = startTime === 0n ? blockTimestamp : startTime;

  if (nParts <= 0 || tSeconds <= 0n) {
    log("warn", "precompute:skip", { orderType: "TWAP", owner, chainId, reason: "invalid_math", nParts, tSeconds: String(tSeconds) });
    return null;
  }
  if (nParts > MAX_TWAP_PRECOMPUTE_PARTS) {
    log("warn", "precompute:skip", { orderType: "TWAP", owner, chainId, reason: "too_many_parts", nParts });
    return null;
  }

  // Receiver: address(0) in the struct means "send to owner"
  const resolvedReceiver =
    receiver === "0x0000000000000000000000000000000000000000" ? owner : receiver;

  const orders: PrecomputedOrder[] = [];

  for (let i = 0; i < nParts; i++) {
    const partIndex = BigInt(i);
    const validTo = spanSeconds === 0n
      ? Number(t0 + (partIndex + 1n) * tSeconds - 1n) // t0 + (partIndex + 1) * t - 1
      : Number(t0 + partIndex * tSeconds + spanSeconds - 1n); // t0 + partIndex * t + span - 1

    const orderData: GPv2OrderData = {
      sellToken: requireHex(sellToken),
      buyToken: requireHex(buyToken),
      receiver: requireHex(resolvedReceiver),
      sellAmount: partSellAmount,
      buyAmount: minPartLimit,
      validTo,
      appData: requireHex(appData),
      feeAmount: 0n,
      kind: KIND_SELL,
      partiallyFillable: false,
      sellTokenBalance: BALANCE_ERC20,
      buyTokenBalance: BALANCE_ERC20,
    };

    const uid = computeOrderUid(chainId, orderData, owner);

    orders.push({
      orderUid: uid.toLowerCase(),
      validTo,
      sellAmount: partSellAmount.toString(),
      buyAmount: minPartLimit.toString(),
      feeAmount: "0",
      possibleValidAfterTimestamp: Number(t0 + partIndex * tSeconds),
    });
  }

  return orders;
}

// ─── StopLoss ────────────────────────────────────────────────────────────────

/**
 * Compute the single StopLoss UID.
 *
 * StopLoss contract logic (StopLoss.sol):
 *   - All order fields come directly from staticInput
 *   - Oracle calls only gate execution (don't affect order data)
 *   - feeAmount = 0
 *   - kind = KIND_SELL if isSellOrder, else KIND_BUY
 *   - sellTokenBalance = buyTokenBalance = ERC20
 */
function precomputeStopLossUid(
  chainId: number,
  owner: Hex,
  params: StopLossDecodedParams,
): PrecomputedOrder[] {
  const { sellToken, buyToken, receiver, sellAmount, buyAmount, appData, isSellOrder, isPartiallyFillable, validTo } = params;
  const resolvedReceiver =
    receiver === "0x0000000000000000000000000000000000000000" ? owner : receiver;

  const orderData: GPv2OrderData = {
    sellToken: requireHex(sellToken),
    buyToken: requireHex(buyToken),
    receiver: requireHex(resolvedReceiver),
    sellAmount,
    buyAmount,
    validTo,
    appData: requireHex(appData),
    feeAmount: 0n,
    kind: isSellOrder ? KIND_SELL : KIND_BUY,
    partiallyFillable: isPartiallyFillable,
    sellTokenBalance: BALANCE_ERC20,
    buyTokenBalance: BALANCE_ERC20,
  };

  const uid = computeOrderUid(chainId, orderData, owner);

  return [{
    orderUid: uid.toLowerCase(),
    validTo,
    sellAmount: sellAmount.toString(),
    buyAmount: buyAmount.toString(),
    feeAmount: "0",
    possibleValidAfterTimestamp: null,
  }];
}

// ─── CirclesBackingOrder ────────────────────────────────────────────────────

/**
 * Compute the single CirclesBackingOrder UID.
 *
 * Source: aboutcircles/circles-lbp/src/CirclesBackingOrder.sol (verified on Gnosis).
 *   - sellToken, sellAmount come from handler constructor immutables (merged into
 *     decodedParams by the event handler before calling here).
 *   - buyToken, buyAmount, validTo, appData come from staticInput.
 *   - receiver = owner (hardcoded in getOrder).
 *   - kind = KIND_SELL, partiallyFillable = false, feeAmount = 0,
 *     sellTokenBalance = buyTokenBalance = BALANCE_ERC20 (all contract constants).
 */
function precomputeCirclesBackingOrderUid(
  chainId: number,
  owner: Hex,
  params: EnrichedCirclesDecodedParams,
): PrecomputedOrder[] {
  const { sellToken, buyToken, sellAmount, buyAmount, validTo, appData } = params;
  const orderData: GPv2OrderData = {
    sellToken,
    buyToken: requireHex(buyToken),
    receiver: owner,
    sellAmount,
    buyAmount,
    validTo,
    appData: requireHex(appData),
    feeAmount: 0n,
    kind: KIND_SELL,
    partiallyFillable: false,
    sellTokenBalance: BALANCE_ERC20,
    buyTokenBalance: BALANCE_ERC20,
  };

  const uid = computeOrderUid(chainId, orderData, owner);

  return [{
    orderUid: uid.toLowerCase(),
    validTo,
    sellAmount: sellAmount.toString(),
    buyAmount: buyAmount.toString(),
    feeAmount: "0",
    possibleValidAfterTimestamp: null,
  }];
}
