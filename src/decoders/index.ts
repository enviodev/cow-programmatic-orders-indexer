import type { Hex } from "viem";
import type { OrderType } from "../utils/order-types.js";
import { decodeTwapStaticInput } from "./twap.js";
import { decodeStopLossStaticInput } from "./stop-loss.js";
import { decodePerpetualSwapStaticInput } from "./perpetual-swap.js";
import { decodeGoodAfterTimeStaticInput } from "./good-after-time.js";
import { decodeTradeAboveThresholdStaticInput } from "./trade-above-threshold.js";

export {
  decodeTwapStaticInput,
  decodeStopLossStaticInput,
  decodePerpetualSwapStaticInput,
  decodeGoodAfterTimeStaticInput,
  decodeTradeAboveThresholdStaticInput,
};

export function decodeStaticInput(orderType: OrderType, staticInput: Hex): unknown {
  switch (orderType) {
    case "TWAP":                return decodeTwapStaticInput(staticInput);
    case "StopLoss":            return decodeStopLossStaticInput(staticInput);
    case "PerpetualSwap":       return decodePerpetualSwapStaticInput(staticInput);
    case "GoodAfterTime":       return decodeGoodAfterTimeStaticInput(staticInput);
    case "TradeAboveThreshold": return decodeTradeAboveThresholdStaticInput(staticInput);
    case "Unknown":             return null;
  }
}
