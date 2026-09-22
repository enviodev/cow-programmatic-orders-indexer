import { type ChainConfig } from "./types.js";

const blockTime = 8.5; // Seconds/block; 100,000-block average, 2026-09-16

export const linea: ChainConfig = {
  name: "linea",
  chainId: 59144,
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 25028474, // verified: tx 0x61f2e7ecec07f7b5c93d491f460cca41eba991fbb022f6866ee17510c9e61151 (cowprotocol/composable-cow networks.json + lineascan.build)
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
    startBlock: 25033271, // verified: tx 0xad527499a510773fed02f46787d8ed9190d52fe40997c661353805e2bc056a65
  },
  gpv2Settlement: {
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    startBlock: 26288706, // AaveV3AdapterFactory deployment block on Linea
  },
  flashLoan: {
    aaveV3: {
      router: "0x9da8B48441583a2b93e2eF8213aAD0EC0b392C69", // verified: ROUTER() on Linea AaveV3AdapterFactory
      adapterFactory: "0xdeCC46a4b09162F5369c5C80383AAa9159bCf192", // CREATE2 — same across chains
    },
  },
  orderbookApiPath: "linea", // TODO: verify CoW Protocol orderbook URL for Linea
  orderbookPollInterval: 60, // ~20 blocks at 3s/block (prior global cadence)
  reorgSafetyWindowSeconds: 1200, // 20 min — covers L1-reorg derived resets
};
