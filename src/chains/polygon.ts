import { type ChainConfig } from "./types.js";

const blockTime = 1.5; // Seconds/block; 10,000-block average, 2026-09-16

export const polygon: ChainConfig = {
  name: "polygon",
  chainId: 137,
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 70406888, // verified: tx 0xef1fdc60092220b9137d2b23189499d995119c281cad648710ac3636bbebf17a (polygonscan.com, 2025-04-17)
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
    startBlock: 74072686, // verified: tx 0x9d877eaa06776c30a409fc31db365e8441f982598586345d53ffaee4f9d2da6d
  },
  gpv2Settlement: {
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    startBlock: 79103055, // AaveV3AdapterFactory deployment block on Polygon
  },
  flashLoan: {
    aaveV3: {
      router: "0x9da8B48441583a2b93e2eF8213aAD0EC0b392C69", // verified: ROUTER() on Polygon AaveV3AdapterFactory
      adapterFactory: "0xdeCC46a4b09162F5369c5C80383AAa9159bCf192", // CREATE2 — same across chains
    },
  },
  orderbookApiPath: "polygon", // TODO: verify CoW Protocol orderbook URL for Polygon
  orderbookPollInterval: 40, // ~20 blocks at 2s/block (prior global cadence)
  reorgSafetyWindowSeconds: 900, // 15 min — milestone finality plus margin
};
