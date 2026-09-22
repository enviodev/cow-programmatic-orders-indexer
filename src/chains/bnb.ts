import { type ChainConfig } from "./types.js";

const blockTime = 0.5; // Seconds/block; 10,000-block average, 2026-09-16

export const bnb: ChainConfig = {
  name: "bnb",
  chainId: 56,
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 48433175, // verified: tx 0x6595bc3c236157c5a164eb37267486b3c2f6eee02d2e6d9068550e939b18ed71 (cowprotocol/composable-cow networks.json + bscscan.com, 2025-04-17)
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
    startBlock: 61362362, // verified: tx 0x76d25671fd1c31044a6cf481df15649fc3503cf5a492de92be8601fee02e259f
  },
  gpv2Settlement: {
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    startBlock: 68412820, // AaveV3AdapterFactory deployment block on BNB
  },
  flashLoan: {
    aaveV3: {
      router: "0x9da8B48441583a2b93e2eF8213aAD0EC0b392C69", // verified: ROUTER() on BNB AaveV3AdapterFactory
      adapterFactory: "0xdeCC46a4b09162F5369c5C80383AAa9159bCf192", // CREATE2 — same across chains
    },
  },
  orderbookApiPath: "bnb", // TODO: verify CoW Protocol orderbook URL for BNB
  orderbookPollInterval: 60, // ~20 blocks at 3s/block (prior global cadence)
  reorgSafetyWindowSeconds: 900, // 15 min — fast finality plus margin
};
