import { type ChainConfig } from "./types.js";

// Seconds/block. 200ms since the Denim hardfork (2026-11-05); was 2s before
// (upstream d9d313e). Settings derived from blockTime keep their wall-clock
// cadence (OrderDiscoveryPoller ~60s, CandidateConfirmer/OrderStatusTracker
// ~5s, orderbook recheck 40s). Fixed block counts do NOT scale and now run 10x
// faster in wall-clock terms: the every-10-blocks handlers (FlashLoanOrderEnricher,
// OwnerBackfill, CancellationWatcher ≈ 2s), DETERMINISTIC_CANCEL_SWEEP_INTERVAL
// (100 blocks ≈ 20s) and the TRY_NEXT_BLOCK backoff (≤ 50 blocks). This matches
// Arbitrum (0.3s blocks). Reorg depth is raised to keep its wall-clock window:
// see max_reorg_depth for Base in config.yaml.
const blockTime = 0.2;

export const base: ChainConfig = {
  name: "base",
  chainId: 8453,
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 21794150, // verified: tx 0xdfa9fded3b1743ce2556a245b17690b073cdd9d59739b60d5e4091e445d732b7 (basescan, 2024-10-31)
  },
  // Official deployments:
  // https://github.com/cowdao-grants/cow-shed/blob/main/networks.json
  cowShedFactory: {
    address: [
      "0x221c28ec177cf7da6f837dfd0052ba8f265fb4ca", // COWShedForComposableCoW factory with executeOwnHooks
      "0x5e284e80f3bd6a7d80a8500d9c49878028110848", // factory for COWShedForComposableCoW
      "0xc94f7d71d022e773b0b516841ff867c06f39726b", // factory for COWShed
      "0x312f92fe5f1710408b20d52a374fa29e099cfa86", // legacy
    ] as const,
    startBlock: 32986811, // verified: tx 0x29c63a32edbf7b29ae73e6a8e5293b65c65906943ad41092205a473e4bbf56d0
  },
  gpv2Settlement: {
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    startBlock: 38260337, // AaveV3AdapterFactory deployment block on Base
  },
  flashLoan: {
    aaveV3: {
      router: "0x9da8B48441583a2b93e2eF8213aAD0EC0b392C69", // verified: ROUTER() on Base AaveV3AdapterFactory
      adapterFactory: "0xdeCC46a4b09162F5369c5C80383AAa9159bCf192", // CREATE2 — same across chains
    },
  },
  orderbookApiPath: "base",
  orderbookPollInterval: 40, // seconds; = 200 blocks at 200ms/block (was 20 blocks at 2s)
  reorgSafetyWindowSeconds: 1200, // 20 min — covers L1-reorg derived resets
};
