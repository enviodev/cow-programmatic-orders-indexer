import { type ChainConfig } from "./types.js";

const blockTime = 1; // Seconds/block; 10,000-block average, 2026-09-16

export const ink: ChainConfig = {
  name: "ink",
  chainId: 57073,
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 34878187, // verified: tx 0xf21049cccc6ea17370e6d3650e689cf3c5be0a097a035953501218a14b8f030f (explorer.inkonchain.com Blockscout API + rpc-gel.inkonchain.com)
  },
  // Official deployments:
  // https://github.com/cowdao-grants/cow-shed/blob/main/networks.json
  cowShedFactory: {
    address: [
      "0x221c28ec177cf7da6f837dfd0052ba8f265fb4ca", // COWShedForComposableCoW factory with executeOwnHooks
      "0x5e284e80f3bd6a7d80a8500d9c49878028110848", // factory for COWShedForComposableCoW
      "0xc94f7d71d022e773b0b516841ff867c06f39726b", // factory for COWShed
    ] as const,
    startBlock: 51750825, // both current factories were deployed in this block
  },
  gpv2Settlement: null, // TODO: enable once flash-loan infra is confirmed on Ink
  flashLoan: null, // TODO: set { aaveV3: { router, adapterFactory } } once flash-loan infra is confirmed on Ink
  orderbookApiPath: "ink", // TODO: verify CoW Protocol orderbook URL for Ink
  orderbookPollInterval: 20 * blockTime,
  reorgSafetyWindowSeconds: 1200, // 20 min — covers L1-reorg derived resets
};
