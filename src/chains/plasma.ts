import { type ChainConfig } from "./types.js";

const blockTime = 1; // Seconds/block; 10,000-block average, 2026-09-16

export const plasma: ChainConfig = {
  name: "plasma",
  chainId: 9745,
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 4810535, // verified: tx 0xa4db8e5f949f39af60460fc05979b363b01570970e94eb8397dc39cfbdcaed86 (cowprotocol/composable-cow networks.json + rpc.plasma.to)
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
    startBlock: 4803028, // verified: tx 0x33d7ed32d433467d75373baf0bcbc99fec65df8a8fd6f67673efa8378f67ebcc
  },
  gpv2Settlement: {
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    startBlock: 7830693, // AaveV3AdapterFactory deployment block on Plasma
  },
  flashLoan: {
    aaveV3: {
      router: "0x9da8B48441583a2b93e2eF8213aAD0EC0b392C69", // verified: ROUTER() on Plasma AaveV3AdapterFactory
      adapterFactory: "0xdeCC46a4b09162F5369c5C80383AAa9159bCf192", // CREATE2 — same across chains
    },
  },
  orderbookApiPath: "plasma", // TODO: verify CoW Protocol orderbook URL for Plasma
  orderbookPollInterval: 20, // ~20 blocks at 1s/block (prior global cadence)
  reorgSafetyWindowSeconds: 1200, // 20 min — covers L1-reorg derived resets
};
