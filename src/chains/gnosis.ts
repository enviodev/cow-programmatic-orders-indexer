import { type ChainConfig } from "./types.js";

const blockTime = 5.2; // Seconds/block; 10,000-block average, 2026-09-16

export const gnosis: ChainConfig = {
  name: "gnosis",
  chainId: 100,
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
    startBlock: 29389123,
  },
  // Official deployments:
  // https://github.com/cowdao-grants/cow-shed/blob/main/networks.json
  cowShedFactory: {
    address: [
      "0x221c28ec177cf7da6f837dfd0052ba8f265fb4ca", // COWShedForComposableCoW factory with executeOwnHooks
      "0x5e284e80f3bd6a7d80a8500d9c49878028110848", // v2.1.0 factory for COWShedForComposableCoW
      "0xc94f7d71d022e773b0b516841ff867c06f39726b", // v2.1.0 factory for COWShed
      "0x4f4350bf2c74aacd508d598a1ba94ef84378793d", // v2.0.0 (CoWShedForComposableCoW)
      "0x312f92fe5f1710408b20d52a374fa29e099cfa86", // legacy (COWShed); 2 historical events
    ] as const,
    startBlock: 41469991, // earliest COWShedBuilt from any configured factory on Gnosis
  },
  gpv2Settlement: {
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    startBlock: 43177077, // AaveV3AdapterFactory deployment block on Gnosis
  },
  flashLoan: {
    aaveV3: {
      router: "0x9da8B48441583a2b93e2eF8213aAD0EC0b392C69", // confirmed via ROUTER() on Gnosis AaveV3AdapterFactory
      adapterFactory: "0xdeCc46a4b09162f5369c5c80383aaa9159bcf192", // verified on Gnosisscan
    },
  },
  orderbookApiPath: "xdai",
  orderbookPollInterval: 100, // ~20 blocks at 5s/block (prior global cadence)
  reorgSafetyWindowSeconds: 300, // 5 min — fast finality
};
