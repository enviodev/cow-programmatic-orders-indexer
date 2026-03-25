import { createEffect, S } from "envio";
import { createPublicClient, http, type Chain, type PublicClient } from "viem";
import { mainnet, gnosis, arbitrum, base, sepolia } from "viem/chains";

// ─── Per-chain viem clients (lazy-initialized) ─────────────────────────────

const CHAINS: Record<number, Chain> = {
  1: mainnet,
  100: gnosis,
  42161: arbitrum,
  8453: base,
  11155111: sepolia,
};

const clients = new Map<number, PublicClient>();

function getClient(chainId: number): PublicClient | null {
  let client = clients.get(chainId);
  if (!client) {
    const rpcUrl = process.env[`ENVIO_RPC_URL_${chainId}`];
    if (!rpcUrl) return null; // No RPC configured — skip gracefully
    const chain = CHAINS[chainId];
    if (!chain) return null;
    client = createPublicClient({ chain, transport: http(rpcUrl) });
    clients.set(chainId, client);
  }
  return client;
}

// ─── Aave V3 Adapter Detection ─────────────────────────────────────────────
// Checks if an address is an Aave V3 flash loan adapter and resolves its EOA owner.
// Returns JSON: { owner: "0x..." } if adapter, or "null" if not.

const AAVE_V3_ADAPTER_FACTORY_ADDRESS =
  "0xdecc46a4b09162f5369c5c80383aaa9159bcf192";

// First block where the factory exists on each chain (OwnershipTransferred log).
// Adapters cannot exist before these blocks, so skip the RPC check entirely.
export const AAVE_FACTORY_DEPLOY_BLOCK: Record<number, number> = {
  1: 23_812_751, // Ethereum
  100: 43_177_077, // Gnosis
  42161: 400_913_741, // Arbitrum
  8453: 38_260_337, // Base
  // Sepolia: not deployed
};

const ADAPTER_ABI = [
  {
    inputs: [],
    name: "FACTORY",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "owner",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const checkAaveAdapter = createEffect(
  {
    name: "checkAaveAdapter",
    input: S.schema({ address: S.string, chainId: S.number }),
    output: S.union([S.string, null]),
    cache: true,
    rateLimit: { calls: 300, per: "second" as const },
  },
  async ({ input }): Promise<string | null> => {
    const client = getClient(input.chainId);
    if (!client) return null; // No RPC configured for this chain
    const address = input.address as `0x${string}`;

    try {
      // Check if it's a contract
      const code = await client.getCode({ address });
      if (!code || code === "0x") return null;

      // Check FACTORY() — reverts if not an Aave adapter
      const factoryAddress = await client.readContract({
        address,
        abi: ADAPTER_ABI,
        functionName: "FACTORY",
      });

      if (factoryAddress.toLowerCase() !== AAVE_V3_ADAPTER_FACTORY_ADDRESS)
        return null;

      // Resolve EOA via owner()
      const eoaOwner = await client.readContract({
        address,
        abi: ADAPTER_ABI,
        functionName: "owner",
      });

      return JSON.stringify({ owner: eoaOwner.toLowerCase() });
    } catch {
      // Not an Aave adapter (call reverted) or RPC error
      return null;
    }
  },
);

// ─── Batch Order Active Check (multicall) ───────────────────────────────────
// Calls ComposableCoW.singleOrders(owner, hash) for a batch of orders.
// Returns JSON array of { hash, owner, active } results.

const COMPOSABLE_COW_ABI = [
  {
    inputs: [
      { name: "", type: "address" },
      { name: "", type: "bytes32" },
    ],
    name: "singleOrders",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ComposableCoW address — same on all chains (CREATE2 deterministic)
const COMPOSABLE_COW_ADDRESS =
  "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74" as const;

export const checkOrdersActive = createEffect(
  {
    name: "checkOrdersActive",
    input: S.schema({
      // JSON-serialized array of { owner, hash } objects
      ordersJson: S.string,
      chainId: S.number,
    }),
    output: S.string, // JSON-serialized results
    cache: false, // On-chain state changes between blocks
    rateLimit: { calls: 2, per: "second" as const },
  },
  async ({ input }): Promise<string> => {
    const client = getClient(input.chainId);
    if (!client) return "[]"; // No RPC configured for this chain
    const orders = JSON.parse(input.ordersJson) as Array<{
      owner: string;
      hash: string;
    }>;

    if (orders.length === 0) return "[]";

    const results = await client.multicall({
      contracts: orders.map((order) => ({
        address: COMPOSABLE_COW_ADDRESS,
        abi: COMPOSABLE_COW_ABI,
        functionName: "singleOrders" as const,
        args: [order.owner as `0x${string}`, order.hash as `0x${string}`],
      })),
    });

    const output = orders.map((order, i) => {
      const result = results[i];
      return {
        hash: order.hash,
        owner: order.owner,
        active:
          result !== undefined &&
          result.status === "success" &&
          result.result === true,
        error: result?.status === "failure" ? String(result.error) : undefined,
      };
    });

    return JSON.stringify(output);
  },
);
