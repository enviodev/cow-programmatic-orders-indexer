import { type ChainConfig } from "./types.js";
import { arbitrum } from "./arbitrum.js";
import { avalanche } from "./avalanche.js";
import { base } from "./base.js";
import { bnb } from "./bnb.js";
import { gnosis } from "./gnosis.js";
import { ink } from "./ink.js";
import { linea } from "./linea.js";
import { mainnet } from "./mainnet.js";
import { plasma } from "./plasma.js";
import { polygon } from "./polygon.js";
import { sepolia } from "./sepolia.js";

export { type ChainConfig, type FlashLoanProvider } from "./types.js";
export { arbitrum, avalanche, base, bnb, gnosis, ink, linea, mainnet, plasma, polygon, sepolia };

/**
 * ALL_DEFINED_CHAINS — every chain configured with a full ChainConfig.
 * Mirrors the upstream ponder indexer's registry at e3f3d63+.
 */
export const ALL_DEFINED_CHAINS: ChainConfig[] = [
  arbitrum, avalanche, base, bnb, gnosis, ink, linea, mainnet, plasma, polygon, sepolia,
];

/**
 * ACTIVE_CHAINS — the chains this indexer instance actually processes.
 *
 * All defined chains are enabled (upstream e3f3d63). Envio streams events from
 * HyperSync, so activation needs no per-chain RPC contract — the on-chain poll
 * effects (src/effects/rpc.ts) use ENVIO_RPC_URL_<chainId> where configured and
 * degrade gracefully where not. config.yaml's network list must mirror this
 * array (addresses and start blocks come from the ChainConfigs).
 */
export const ACTIVE_CHAINS: ChainConfig[] = ALL_DEFINED_CHAINS;
