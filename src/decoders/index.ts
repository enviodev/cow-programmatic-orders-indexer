import type { Hex } from "viem";
import type { OrderType } from "../utils/order-types.js";
import { decodeTwapStaticInput } from "./twap.js";
import { decodeStopLossStaticInput } from "./stop-loss.js";
import { decodePerpetualSwapStaticInput } from "./perpetual-swap.js";
import { decodeGoodAfterTimeStaticInput } from "./good-after-time.js";
import { decodeTradeAboveThresholdStaticInput } from "./trade-above-threshold.js";
import { decodeCirclesBackingOrderStaticInput } from "./circles-backing-order.js";
import { decodeSwapOrderHandlerStaticInput } from "./swap-order-handler.js";
import { decodeErc4626CowSwapFeeBurnerStaticInput } from "./erc4626-cow-swap-fee-burner.js";

export {
  decodeTwapStaticInput,
  decodeStopLossStaticInput,
  decodePerpetualSwapStaticInput,
  decodeGoodAfterTimeStaticInput,
  decodeTradeAboveThresholdStaticInput,
  decodeCirclesBackingOrderStaticInput,
  decodeSwapOrderHandlerStaticInput,
  decodeErc4626CowSwapFeeBurnerStaticInput,
};

export type DecodedOrder =
  | { orderType: "TWAP"; decodedParams: ReturnType<typeof decodeTwapStaticInput> }
  | { orderType: "StopLoss"; decodedParams: ReturnType<typeof decodeStopLossStaticInput> }
  | { orderType: "PerpetualSwap"; decodedParams: ReturnType<typeof decodePerpetualSwapStaticInput> }
  | { orderType: "GoodAfterTime"; decodedParams: ReturnType<typeof decodeGoodAfterTimeStaticInput> }
  | { orderType: "TradeAboveThreshold"; decodedParams: ReturnType<typeof decodeTradeAboveThresholdStaticInput> }
  | { orderType: "CirclesBackingOrder"; decodedParams: ReturnType<typeof decodeCirclesBackingOrderStaticInput> }
  | { orderType: "SwapOrderHandler"; decodedParams: ReturnType<typeof decodeSwapOrderHandlerStaticInput> }
  | { orderType: "ERC4626CowSwapFeeBurner"; decodedParams: ReturnType<typeof decodeErc4626CowSwapFeeBurnerStaticInput> };

/**
 * Decode a generator's staticInput into native values (bigint, boolean, number),
 * tagged with its order type. Callers serialize bigints only at the storage edge:
 * UID computation must see the native values (upstream 9db52cd).
 */
export function decodeStaticInput(orderType: OrderType, staticInput: Hex): DecodedOrder | null {
  switch (orderType) {
    case "TWAP":                    return { orderType, decodedParams: decodeTwapStaticInput(staticInput) };
    case "StopLoss":                return { orderType, decodedParams: decodeStopLossStaticInput(staticInput) };
    case "PerpetualSwap":           return { orderType, decodedParams: decodePerpetualSwapStaticInput(staticInput) };
    case "GoodAfterTime":           return { orderType, decodedParams: decodeGoodAfterTimeStaticInput(staticInput) };
    case "TradeAboveThreshold":     return { orderType, decodedParams: decodeTradeAboveThresholdStaticInput(staticInput) };
    case "CirclesBackingOrder":     return { orderType, decodedParams: decodeCirclesBackingOrderStaticInput(staticInput) };
    case "SwapOrderHandler":        return { orderType, decodedParams: decodeSwapOrderHandlerStaticInput(staticInput) };
    case "ERC4626CowSwapFeeBurner": return { orderType, decodedParams: decodeErc4626CowSwapFeeBurnerStaticInput(staticInput) };
    // CurveCowSwapBurner, BalancerCowSwapFeeBurner, CowAmmConstantProduct have no
    // staticInput decoder upstream — their params live in contract state, not staticInput.
    default:                        return null;
  }
}
