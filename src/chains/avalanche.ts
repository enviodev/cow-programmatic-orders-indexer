import { type ChainConfig } from "./types.js";

const blockTime = 1.1; // Seconds/block; 10,000-block average, 2026-09-16

export const avalanche: ChainConfig = {
  name: "avalanche",
  chainId: 43114,
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 60434336, // verified: tx 0xaa800a7183e8313e11a0024a8fe189770c33aaf8fc1451a3a5c373898e25fefa (snowscan.xyz, 2025-04-17)
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
    startBlock: 65617025, // verified: tx 0xcf5f0c9a40d26d09e497a6ce871df31ca13d8e72b1724d8ba015368cf36068f1
  },
  gpv2Settlement: {
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    startBlock: 72063515, // AaveV3AdapterFactory deployment block on Avalanche
  },
  flashLoan: {
    aaveV3: {
      router: "0x9da8B48441583a2b93e2eF8213aAD0EC0b392C69", // verified: ROUTER() on Avalanche AaveV3AdapterFactory
      adapterFactory: "0xdeCC46a4b09162F5369c5C80383AAa9159bCf192", // CREATE2 — same across chains
    },
  },
  orderbookApiPath: "avalanche", // TODO: verify CoW Protocol orderbook URL for Avalanche
  orderbookPollInterval: 40, // ~20 blocks at 2s/block (prior global cadence)
  reorgSafetyWindowSeconds: 300, // 5 min — sub-second finality plus margin
};
