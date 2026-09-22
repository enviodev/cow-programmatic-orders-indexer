import { type ChainConfig } from "./types.js";

const blockTime = 12.5; // Seconds/block; 10,000-block average, 2026-09-16

export const sepolia: ChainConfig = {
  name: "sepolia",
  chainId: 11155111,
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 5072748, // verified: tx 0xed9625240dec4803ea76358bcac3d4c8678b81a6ffddd50c0326c12626d3f38e (cowprotocol/composable-cow networks.json + sepolia.etherscan.io, 2024-01-12)
  },
  // Official deployments:
  // https://github.com/cowdao-grants/cow-shed/blob/main/networks.json
  cowShedFactory: {
    address: [
      "0x221c28ec177cf7da6f837dfd0052ba8f265fb4ca", // COWShedForComposableCoW factory with executeOwnHooks
      "0x5e284e80f3bd6a7d80a8500d9c49878028110848", // v2.1.0 factory for COWShedForComposableCoW
      "0xc94f7d71d022e773b0b516841ff867c06f39726b", // v2.1.0 factory for COWShed
      "0x312f92fe5f1710408b20d52a374fa29e099cfa86", // legacy (COWShed)
    ] as const,
    startBlock: 8784028, // verified: tx 0x4d42972f24fa0846523513e7733b1d2238d0a709c3e4a2cd415cc64885bd1762
  },
  gpv2Settlement: null, // TODO: enable once flash-loan infra is confirmed on Sepolia
  flashLoan: null, // TODO: set { aaveV3: { router, adapterFactory } } once flash-loan infra is confirmed on Sepolia
  orderbookApiPath: "sepolia",
  orderbookPollInterval: 20 * blockTime,
  reorgSafetyWindowSeconds: 300, // 5 min — testnet
};
