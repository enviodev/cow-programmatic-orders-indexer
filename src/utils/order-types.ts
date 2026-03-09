export type OrderType =
  | "TWAP"
  | "StopLoss"
  | "PerpetualSwap"
  | "GoodAfterTime"
  | "TradeAboveThreshold"
  | "Unknown";

// Handler addresses from cowprotocol/composable-cow — same on all chains (CREATE2).
// Mainnet addresses confirmed from on-chain events.
// Other chains may have different handler versions — extend as discovered.
const GLOBAL_HANDLER_MAP: Record<string, OrderType> = {
  "0x6cf1e9ca41f7611def408122793c358a3d11e5a5": "TWAP",
  "0xe8212f30c28b4aab467df3725c14d6e89c2eb967": "StopLoss",
  "0x412c36e5011cd2517016d243a2dfb37f73a242e7": "StopLoss", // alternate deployment
  "0x963f411ac754055b611fe464fa4d50772e9b1f9c": "PerpetualSwap",
  "0x519ba24e959e33b3b6220ca98bd353d8c2d89920": "PerpetualSwap", // alternate deployment
  "0x58d2b4b0a29e2d8635b0b47244f3654b1c0f38e9": "GoodAfterTime",
  "0xdaf33924925e03c9cc3a10d434016d6cfad0add5": "GoodAfterTime", // alternate deployment
  "0x812308712a6d1367f437e1c1e4af85c854e1e9f6": "TradeAboveThreshold",
};

// Per-chain overrides if a chain has unique handler addresses
const CHAIN_HANDLER_MAP: Record<number, Record<string, OrderType>> = {
  // Add chain-specific overrides here as discovered
};

export function getOrderTypeFromHandler(
  handler: string,
  chainId: number,
): OrderType {
  const addr = handler.toLowerCase();
  return CHAIN_HANDLER_MAP[chainId]?.[addr] ?? GLOBAL_HANDLER_MAP[addr] ?? "Unknown";
}
