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

export function decodeStaticInput(orderType: OrderType, staticInput: Hex): unknown {
  switch (orderType) {
    case "TWAP":                    return decodeTwapStaticInput(staticInput);
    case "StopLoss":                return decodeStopLossStaticInput(staticInput);
    case "PerpetualSwap":           return decodePerpetualSwapStaticInput(staticInput);
    case "GoodAfterTime":           return decodeGoodAfterTimeStaticInput(staticInput);
    case "TradeAboveThreshold":     return decodeTradeAboveThresholdStaticInput(staticInput);
    case "CirclesBackingOrder":     return decodeCirclesBackingOrderStaticInput(staticInput);
    case "SwapOrderHandler":        return decodeSwapOrderHandlerStaticInput(staticInput);
    case "ERC4626CowSwapFeeBurner": return decodeErc4626CowSwapFeeBurnerStaticInput(staticInput);
    // CurveCowSwapBurner, BalancerCowSwapFeeBurner, CowAmmConstantProduct have no
    // staticInput decoder upstream — their params live in contract state, not staticInput.
    default:                        return null;
  }
}
