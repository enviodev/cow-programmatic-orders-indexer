/**
 * On-chain RPC effects. All external RPC goes through the Effect API so envio
 * can dedupe (preload), cache, and rate-limit calls.
 *
 * Requires ENVIO_RPC_URL_<chainId> env vars (HyperSync covers event indexing;
 * these are for view calls / receipts only).
 */

import { createEffect, S } from "envio";
import { createPublicClient, http, keccak256, toBytes, type Chain, type Hex, type PublicClient } from "viem";
import { mainnet, gnosis } from "viem/chains";
import {
  AAVE_V3_ADAPTER_FACTORY_ADDRESSES,
  COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID,
  GPV2_SETTLEMENT_DEPLOYMENTS,
} from "../data.js";
import {
  BLOCK_HANDLER_RPC_TIMEOUT_MS,
  SETTLEMENT_INNER_RPC_TIMEOUT_MS,
} from "../constants.js";
import { withTimeout, TimeoutError } from "../helpers/withTimeout.js";
import { log } from "../helpers/logger.js";
import { GET_TRADEABLE_ORDER_WITH_ERRORS_ABI, parsePollError, type PollResult } from "../helpers/pollResultErrors.js";
import { AaveV3AdapterHelperAbi } from "../abis/AaveV3AdapterHelperAbi.js";
import { CirclesBackingOrderAbi } from "../abis/CirclesBackingOrderAbi.js";
import {
  decodeTradeData,
  decodeValidToFromOrderUid,
  detectFlashLoanOrderType,
} from "../decoders/flash-loan-order.js";

// ─── Per-chain viem clients (lazy-initialized) ─────────────────────────────

const CHAINS: Record<number, Chain> = {
  1: mainnet,
  100: gnosis,
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

// ─── Batch Order Active Check (multicall) ───────────────────────────────────
// Calls ComposableCoW.singleOrders(owner, hash) for a batch of generators.
// Used by CancellationWatcher: `false` means the owner called remove().

const SINGLE_ORDERS_ABI = [
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
    const composableCowAddress = COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID[input.chainId];
    if (!composableCowAddress) return "[]";
    const orders = JSON.parse(input.ordersJson) as Array<{
      owner: string;
      hash: string;
    }>;

    if (orders.length === 0) return "[]";

    let results;
    try {
      results = await withTimeout(
        client.multicall({
          contracts: orders.map((order) => ({
            address: composableCowAddress,
            abi: SINGLE_ORDERS_ABI,
            functionName: "singleOrders" as const,
            args: [order.owner as `0x${string}`, order.hash as `0x${string}`],
          })),
        }),
        BLOCK_HANDLER_RPC_TIMEOUT_MS,
        "checkOrdersActive:multicall",
      );
    } catch (err) {
      if (err instanceof TimeoutError) {
        log("warn", "checkOrdersActive:multicall_timeout", { chainId: input.chainId, due: orders.length });
        return "[]";
      }
      throw err;
    }

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

// ─── getTradeableOrderWithSignature poll (multicall) ────────────────────────
// Used by OrderDiscoveryPoller. Returns per-order typed results: on success the
// GPv2 order struct (bigints stringified), on revert the parsed PollResult.

export interface PollOrderInput {
  owner: string;
  handler: string;
  salt: string;
  staticInput: string;
}

export type PollOrderResult =
  | {
      status: "success";
      order: {
        sellToken: string; buyToken: string; receiver: string;
        sellAmount: string; buyAmount: string; validTo: number;
        appData: string; feeAmount: string; kind: string;
        partiallyFillable: boolean; sellTokenBalance: string; buyTokenBalance: string;
      };
    }
  | { status: "error"; pollResult: PollResultJson }
  | { status: "unavailable" }; // multicall timeout / no RPC — leave state untouched

// PollResult with bigints stringified for JSON transport.
export type PollResultJson =
  | { type: "tryNextBlock" }
  | { type: "tryAtBlock"; blockNumber: string }
  | { type: "tryAtEpoch"; timestamp: string }
  | { type: "never"; reason: string }
  | { type: "cancelled" }
  | { type: "success" };

function pollResultToJson(r: PollResult): PollResultJson {
  switch (r.type) {
    case "tryAtBlock": return { type: "tryAtBlock", blockNumber: r.blockNumber.toString() };
    case "tryAtEpoch": return { type: "tryAtEpoch", timestamp: r.timestamp.toString() };
    default: return r as PollResultJson;
  }
}

export const pollTradeableOrders = createEffect(
  {
    name: "pollTradeableOrders",
    input: S.schema({
      chainId: S.number,
      // JSON-serialized PollOrderInput[]
      ordersJson: S.string,
    }),
    output: S.string, // JSON-serialized PollOrderResult[]
    cache: false, // on-chain state changes between blocks
    rateLimit: { calls: 5, per: "second" as const },
  },
  async ({ input }): Promise<string> => {
    const orders = JSON.parse(input.ordersJson) as PollOrderInput[];
    if (orders.length === 0) return "[]";

    const client = getClient(input.chainId);
    const composableCowAddress = COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID[input.chainId];
    if (!client || !composableCowAddress) {
      return JSON.stringify(orders.map(() => ({ status: "unavailable" })));
    }

    let results;
    try {
      results = await withTimeout(
        client.multicall({
          contracts: orders.map((order) => ({
            address: composableCowAddress,
            abi: GET_TRADEABLE_ORDER_WITH_ERRORS_ABI,
            functionName: "getTradeableOrderWithSignature" as const,
            args: [
              order.owner as Hex,
              { handler: order.handler as Hex, salt: order.salt as Hex, staticInput: order.staticInput as Hex },
              "0x" as Hex,
              [] as Hex[],
            ] as const,
          })),
          allowFailure: true,
        }),
        BLOCK_HANDLER_RPC_TIMEOUT_MS,
        "pollTradeableOrders:multicall",
      );
    } catch (err) {
      if (err instanceof TimeoutError) {
        log("warn", "pollTradeableOrders:multicall_timeout", { chainId: input.chainId, due: orders.length });
        return JSON.stringify(orders.map(() => ({ status: "unavailable" })));
      }
      throw err;
    }

    const output: PollOrderResult[] = results.map((result) => {
      if (result === undefined) return { status: "unavailable" };
      if (result.status === "success") {
        const [orderData] = result.result as unknown as [
          {
            sellToken: Hex; buyToken: Hex; receiver: Hex;
            sellAmount: bigint; buyAmount: bigint; validTo: number;
            appData: Hex; feeAmount: bigint; kind: Hex;
            partiallyFillable: boolean; sellTokenBalance: Hex; buyTokenBalance: Hex;
          },
          Hex,
        ];
        return {
          status: "success",
          order: {
            sellToken: orderData.sellToken,
            buyToken: orderData.buyToken,
            receiver: orderData.receiver,
            sellAmount: orderData.sellAmount.toString(),
            buyAmount: orderData.buyAmount.toString(),
            validTo: Number(orderData.validTo),
            appData: orderData.appData,
            feeAmount: orderData.feeAmount.toString(),
            kind: orderData.kind,
            partiallyFillable: orderData.partiallyFillable,
            sellTokenBalance: orderData.sellTokenBalance,
            buyTokenBalance: orderData.buyTokenBalance,
          },
        };
      }
      return { status: "error", pollResult: pollResultToJson(parsePollError(result.error)) };
    });

    return JSON.stringify(output);
  },
);

// ─── Aave settlement receipt scan ────────────────────────────────────────────
// Ports the inner RPC logic of upstream settlement.ts: fetch the settlement tx
// receipt, and for every GPv2 Trade log check whether the trade owner is an
// Aave V3 flash-loan adapter (getCode + FACTORY() + owner()). Returns the
// confirmed flash-loan order candidates. Cached: the analysis of a mined tx is
// immutable (adapter owner() is set once per per-order CREATE2 clone).

// Trade(address,address,address,uint256,uint256,uint256,bytes) — topic0 hash
const TRADE_TOPIC = keccak256(
  toBytes("Trade(address,address,address,uint256,uint256,uint256,bytes)"),
);

// FACTORY() selector — keccak256("FACTORY()")[0:4].
// Raw eth_call instead of readContract to avoid noisy decode errors on
// non-adapter contracts that don't implement FACTORY().
const FACTORY_SELECTOR = "0x2dd31000" as const;

export interface AaveSettlementCandidate {
  adapter: string;
  orderUid: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  validTo: number;
  owner: string | null; // resolved EOA, null when owner() failed
  type: "RepayWithCollateral" | "CollateralSwap" | "DebtSwap" | null;
}

/** Scan failed on a transport-level error (RPC timeout / rate limit / network).
 *  Thrown (never returned) so the failure is NOT persisted in the effect cache —
 *  the handler records a PendingSettlementScan and FlashLoanScanRetrier retries.
 *  Upstream silently drops these settlements. */
export class SettlementScanUnavailableError extends Error {
  constructor(stage: string, cause: unknown) {
    super(`[COW:scan-unavailable] ${stage}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "SettlementScanUnavailableError";
  }
}

/** Transport-level failure (retryable) vs an execution revert (a real answer:
 *  "not an adapter"). viem transport errors: HttpRequestError family; plus our
 *  own TimeoutError from withTimeout. */
function isTransportError(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    if (
      current.name === "HttpRequestError" ||
      current.name === "TimeoutError" ||
      current.name === "RpcRequestError" ||
      current.name === "SocketClosedError" ||
      current.name === "WebSocketRequestError"
    ) {
      return true;
    }
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

export const scanAaveSettlement = createEffect(
  {
    name: "scanAaveSettlement",
    input: S.schema({ chainId: S.number, txHash: S.string }),
    output: S.string, // JSON-serialized AaveSettlementCandidate[]
    cache: true, // mined-tx analysis is immutable; failures THROW so only successes cache
    rateLimit: { calls: 10, per: "second" as const },
  },
  async ({ input }): Promise<string> => {
    const { chainId, txHash } = input;
    const client = getClient(chainId);
    if (!client) throw new SettlementScanUnavailableError("no-rpc", `ENVIO_RPC_URL_${chainId} unset`);

    const settlementDeployment = GPV2_SETTLEMENT_DEPLOYMENTS[chainId];
    if (!settlementDeployment) return "[]";
    const settlementAddress = settlementDeployment.address.toLowerCase();

    const adapterFactoryAddress = AAVE_V3_ADAPTER_FACTORY_ADDRESSES[chainId]?.toLowerCase();
    if (!adapterFactoryAddress) return "[]";

    let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>>;
    try {
      receipt = await withTimeout(
        client.getTransactionReceipt({ hash: txHash as Hex }),
        BLOCK_HANDLER_RPC_TIMEOUT_MS,
        "scanAaveSettlement:getTransactionReceipt",
      );
    } catch (err) {
      // A mined settlement tx always has a receipt eventually — any failure
      // here (incl. not-found from a lagging node) is worth retrying.
      log("warn", "scanAaveSettlement:receipt_failed", { chainId, txHash, err: err instanceof Error ? err.message : String(err) });
      throw new SettlementScanUnavailableError("receipt", err);
    }

    const candidates: AaveSettlementCandidate[] = [];

    for (const txLog of receipt.logs) {
      if (txLog.address.toLowerCase() !== settlementAddress) continue;
      if (txLog.topics[0] !== TRADE_TOPIC) continue;

      const owner = `0x${txLog.topics[1]!.slice(26)}` as `0x${string}`;
      const ownerAddress = owner.toLowerCase() as `0x${string}`;

      let code: `0x${string}` | undefined;
      try {
        code = await withTimeout(
          client.getCode({ address: owner }),
          SETTLEMENT_INNER_RPC_TIMEOUT_MS,
          "scanAaveSettlement:getCode",
        );
      } catch (err) {
        log("warn", "scanAaveSettlement:getCode_failed", { chainId, owner, err: err instanceof Error ? err.message : String(err) });
        throw new SettlementScanUnavailableError("getCode", err); // transport — retry the whole scan
      }
      if (!code || code === "0x") continue; // EOA — not an adapter

      let factoryData: `0x${string}` | undefined;
      try {
        const result = await withTimeout(
          client.call({ to: owner, data: FACTORY_SELECTOR }),
          SETTLEMENT_INNER_RPC_TIMEOUT_MS,
          "scanAaveSettlement:call:FACTORY",
        );
        factoryData = result.data;
      } catch (err) {
        if (isTransportError(err)) {
          throw new SettlementScanUnavailableError("FACTORY", err); // retryable
        }
        continue; // reverted — not an adapter
      }

      if (!factoryData || factoryData.length < 66) continue;

      const factoryAddress = `0x${factoryData.slice(26)}` as `0x${string}`;
      if (factoryAddress.toLowerCase() !== adapterFactoryAddress) continue;

      // Confirmed Aave adapter. Decode the Trade log data the topic-only read discarded.
      let trade;
      try {
        trade = decodeTradeData(txLog.data);
      } catch (err) {
        log("warn", "scanAaveSettlement:decodeTrade_failed", { chainId, owner, err: err instanceof Error ? err.message : String(err) });
        continue;
      }
      const validTo = decodeValidToFromOrderUid(trade.orderUid);
      // EIP-1167 implementation → adapter type, from the getCode result (no extra RPC).
      const flashLoanType = detectFlashLoanOrderType(code);

      // Resolve the EOA from the adapter's owner() — durable on-chain state that
      // survives settlement (unlike getHookData(), whose struct is wiped).
      let eoaOwner: string | null = null;
      try {
        const resolved = await withTimeout(
          client.readContract({
            address: owner,
            abi: AaveV3AdapterHelperAbi,
            functionName: "owner",
          }),
          BLOCK_HANDLER_RPC_TIMEOUT_MS,
          "scanAaveSettlement:readContract:owner",
        );
        eoaOwner = (resolved as string).toLowerCase();
      } catch (err) {
        if (isTransportError(err)) {
          throw new SettlementScanUnavailableError("owner", err); // retryable
        }
        // Revert — keep the order with owner null (upstream behaviour).
        log("warn", "scanAaveSettlement:readOwner_failed", { chainId, owner, err: err instanceof Error ? err.message : String(err) });
      }

      candidates.push({
        adapter: ownerAddress,
        orderUid: trade.orderUid,
        sellToken: trade.sellToken,
        buyToken: trade.buyToken,
        sellAmount: trade.sellAmount.toString(),
        buyAmount: trade.buyAmount.toString(),
        feeAmount: trade.feeAmount.toString(),
        validTo,
        owner: eoaOwner,
        type: flashLoanType,
      });
    }

    return JSON.stringify(candidates);
  },
);

// ─── Block timestamp lookup ─────────────────────────────────────────────────
// envio onBlock handlers only receive the block number; upstream block handlers
// use event.block.timestamp. Cached forever (mined-block header is immutable).

export const getBlockTimestamp = createEffect(
  {
    name: "getBlockTimestamp",
    input: S.schema({ chainId: S.number, blockNumber: S.number }),
    output: S.union([S.number, null]),
    cache: true,
    rateLimit: { calls: 10, per: "second" as const },
  },
  async ({ input }): Promise<number | null> => {
    const client = getClient(input.chainId);
    if (!client) return null;
    try {
      const block = await withTimeout(
        client.getBlock({ blockNumber: BigInt(input.blockNumber) }),
        SETTLEMENT_INNER_RPC_TIMEOUT_MS,
        "getBlockTimestamp",
      );
      return Number(block.timestamp);
    } catch {
      return null;
    }
  },
);

// ─── CirclesBackingOrder handler immutables ─────────────────────────────────
// Handler-instance constants (set in the constructor) — identical for every
// generator that references the same handler address. Cached indefinitely.

export const circlesImmutables = createEffect(
  {
    name: "circlesImmutables",
    input: S.schema({ chainId: S.number, handler: S.string }),
    output: S.union([S.string, null]), // JSON { sellToken, sellAmount } | null on failure
    cache: true, // contract immutables never change
    rateLimit: { calls: 5, per: "second" as const },
  },
  async ({ input }): Promise<string | null> => {
    const client = getClient(input.chainId);
    if (!client) return null;
    const handler = input.handler as `0x${string}`;

    try {
      const [sellToken, sellAmount] = await Promise.all([
        client.readContract({
          address: handler,
          abi: CirclesBackingOrderAbi,
          functionName: "SELL_TOKEN",
        }) as Promise<Hex>,
        client.readContract({
          address: handler,
          abi: CirclesBackingOrderAbi,
          functionName: "SELL_AMOUNT",
        }) as Promise<bigint>,
      ]);
      return JSON.stringify({
        sellToken: sellToken.toLowerCase(),
        sellAmount: sellAmount.toString(),
      });
    } catch (err) {
      log("warn", "circlesImmutables:read_failed", { chainId: input.chainId, handler, err: String(err) });
      return null;
    }
  },
);
