/**
 * Chain-derived runtime constants. Ported 1:1 from the upstream ponder
 * indexer's src/data.ts (keyed by chain ID rather than ponder chain name).
 */

import { ALL_HANDLER_ADDRESSES } from "./utils/order-types.js";
import { ACTIVE_CHAINS, ALL_DEFINED_CHAINS } from "./chains/index.js";

// CREATE2-deployed contracts share the same address across chains
export const GPV2_SETTLEMENT_ADDRESS =
  "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as const;

/**
 * Per-chain orderbook recheck cadence, in blocks, keyed by chain ID.
 * Derived from each chain's orderbookPollInterval (seconds) and blockTime:
 *   blocks = max(1, round(orderbookPollInterval / blockTime)).
 * Partial: lookups fall back to DEFAULT_RECHECK_INTERVAL_BLOCKS (src/constants.ts).
 */
export const RECHECK_INTERVAL_BLOCKS_BY_CHAIN_ID: Partial<Record<number, bigint>> =
  Object.fromEntries(
    ALL_DEFINED_CHAINS.map((c) => [
      c.chainId,
      BigInt(Math.max(1, Math.round(c.orderbookPollInterval / c.blockTime))),
    ]),
  );

/**
 * Human-readable chain names keyed by chain ID (active chains only).
 */
export const CHAIN_NAMES: Partial<Record<number, string>> =
  Object.fromEntries(ACTIVE_CHAINS.map((c) => [c.chainId, c.name]));

/**
 * ComposableCoW address keyed by numeric chain ID (active chains only).
 */
export const COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID: Partial<Record<number, `0x${string}`>> =
  Object.fromEntries(ACTIVE_CHAINS.map((c) => [c.chainId, c.composableCow.address]));

/**
 * Known ComposableCoW order handler addresses — union of the chain-agnostic map
 * + all per-chain overlays. Used by the EIP-1271 decoder path to validate that a
 * decoded signature belongs to a composable order. Chain-global union by design.
 */
export const COMPOSABLE_COW_HANDLER_ADDRESSES = new Set(ALL_HANDLER_ADDRESSES);

/**
 * CoW Protocol Orderbook API base URLs per chain ID.
 */
export const ORDERBOOK_API_URLS: Record<number, string> = Object.fromEntries(
  ALL_DEFINED_CHAINS.map((c) => [c.chainId, `https://api.cow.fi/${c.orderbookApiPath}`]),
);

/**
 * Aave V3 adapter factory addresses keyed by chain ID.
 * Only chains with Aave V3 flash-loan infra are included.
 */
export const AAVE_V3_ADAPTER_FACTORY_ADDRESSES: Partial<Record<number, `0x${string}`>> =
  Object.fromEntries(
    ACTIVE_CHAINS
      .filter((c) => c.flashLoan !== null)
      .map((c) => [c.chainId, c.flashLoan!.aaveV3.adapterFactory]),
  );

/**
 * Aave V3 flash-loan router addresses keyed by chain ID — used to filter
 * GPv2Settlement:Settlement events by solver.
 */
export const AAVE_V3_ROUTER_ADDRESSES: Partial<Record<number, `0x${string}`>> =
  Object.fromEntries(
    ACTIVE_CHAINS
      .filter((c) => c.flashLoan !== null)
      .map((c) => [c.chainId, c.flashLoan!.aaveV3.router]),
  );

/**
 * GPv2Settlement deployment info keyed by chain ID.
 * Only chains with a non-null gpv2Settlement are included.
 */
export const GPV2_SETTLEMENT_DEPLOYMENTS: Partial<
  Record<number, { address: `0x${string}`; startBlock: number }>
> = Object.fromEntries(
  ACTIVE_CHAINS
    .filter((c) => c.gpv2Settlement !== null)
    .map((c) => [c.chainId, c.gpv2Settlement!]),
);
