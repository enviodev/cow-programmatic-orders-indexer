import { type ChainConfig } from "./types.js";

const blockTime = 0.3; // Seconds/block; 10,000-block average, 2026-09-16

export const arbitrum: ChainConfig = {
  name: "arbitrum",
  chainId: 42161,
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 204751436, // verified: tx 0xede8f4305385f5df63d5221d1377380724c11781000b30a29cf636241abaa59f (cowprotocol/composable-cow networks.json + arbiscan)
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
    startBlock: 358667546, // verified: tx 0x97b8fa7baf78bca1836e6a7cdce3bd0b983fa96352fc168ebf5f24ba63f23a91
  },
  gpv2Settlement: {
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    startBlock: 400913741, // AaveV3AdapterFactory deployment block on Arbitrum
  },
  flashLoan: {
    aaveV3: {
      router: "0x9da8B48441583a2b93e2eF8213aAD0EC0b392C69", // verified: ROUTER() on Arbitrum AaveV3AdapterFactory
      adapterFactory: "0xdeCC46a4b09162F5369c5C80383AAa9159bCf192", // CREATE2 — same across chains
    },
  },
  orderbookApiPath: "arbitrum_one",
  orderbookPollInterval: 20, // ~20 blocks at 1s/block (prior global cadence)
  reorgSafetyWindowSeconds: 1200, // 20 min — covers L1-reorg derived resets
};
