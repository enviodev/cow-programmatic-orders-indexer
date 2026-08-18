/**
 * ChainConfig — everything needed to configure one chain (mirrors the upstream
 * ponder indexer's src/chains/types.ts, minus ponder-specific RPC env wiring).
 *
 * Add a new chain by:
 *   1. Creating src/chains/<name>.ts implementing this interface.
 *   2. Adding it to ACTIVE_CHAINS in src/chains/index.ts.
 *   3. Adding the chain + contracts to config.yaml (addresses/start blocks must match).
 */

/**
 * One flash-loan provider's on-chain infrastructure on a given chain.
 *  - `router`: the provider's FlashLoanRouter — settles flash-loan orders; used
 *    to filter GPv2Settlement:Settlement events by solver.
 *  - `adapterFactory`: the provider's adapter factory — used for view calls to
 *    detect flash-loan adapter accounts (not an indexed contract).
 */
export interface FlashLoanProvider {
  router: `0x${string}`;
  adapterFactory: `0x${string}`;
}

export interface ChainConfig {
  /** Chain key (e.g. "mainnet", "gnosis"). */
  name: string;
  /** EIP-155 chain ID. */
  chainId: number;
  /** Approximate block time in seconds — used to derive poll cadences. */
  blockTime: number;

  /** ComposableCoW CREATE2 deployment on this chain. */
  composableCow: { address: `0x${string}`; startBlock: number };

  /**
   * CoWShedFactory deployment(s) on this chain.
   * Gnosis has two factory addresses (current + legacy), so address may be an array.
   * Null when the factory address hasn't been confirmed for this chain yet.
   */
  cowShedFactory: {
    address: `0x${string}` | readonly `0x${string}`[];
    startBlock: number;
  } | null;

  /** GPv2Settlement deployment — null if not indexed on this chain. */
  gpv2Settlement: { address: `0x${string}`; startBlock: number } | null;

  /**
   * Flash-loan infrastructure for this chain — null if none is deployed.
   * Keyed by provider so other flash-loan kinds can be added as new keys.
   */
  flashLoan: { aaveV3: FlashLoanProvider } | null;

  /**
   * CoW Protocol Orderbook API path for this chain (the part after https://api.cow.fi/).
   * e.g. "mainnet", "xdai", "arbitrum_one".
   */
  orderbookApiPath: string;

  /**
   * Orderbook recheck cadence for this chain, in **seconds** (wall-clock).
   * Converted to a per-chain block offset at runtime as
   * `max(1, round(orderbookPollInterval / blockTime))` (see src/data.ts).
   */
  orderbookPollInterval: number;
}
