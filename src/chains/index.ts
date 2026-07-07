import { type ChainConfig } from "./types.js";
import { mainnet } from "./mainnet.js";
import { gnosis } from "./gnosis.js";

export { type ChainConfig, type FlashLoanProvider } from "./types.js";
export { mainnet, gnosis };

/**
 * ACTIVE_CHAINS — the chains this indexer instance actually processes.
 * Mirrors the upstream ponder indexer's ACTIVE_CHAINS (mainnet + gnosis).
 *
 * To enable a chain: create its src/chains/<name>.ts, add it here, and add the
 * chain + contract entries to config.yaml (addresses and start blocks must match
 * the ChainConfig). Envio uses HyperSync, so no RPC URL is needed for event
 * indexing — but the on-chain poll effects (src/effects/rpc.ts) need
 * ENVIO_RPC_URL_<chainId> for the chain.
 */
export const ACTIVE_CHAINS: ChainConfig[] = [mainnet, gnosis];

/**
 * ALL_DEFINED_CHAINS — every chain configured with a full ChainConfig.
 * Upstream defines 12 chains (10 inactive); this port defines only the active
 * two — add chain files here as they're activated.
 */
export const ALL_DEFINED_CHAINS: ChainConfig[] = [mainnet, gnosis];
