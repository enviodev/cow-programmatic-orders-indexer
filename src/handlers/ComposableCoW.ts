/**
 * ConditionalOrderCreated handler — indexes generators and triggers UID
 * pre-computation for deterministic order types. Ported from the upstream
 * ponder indexer's composableCow.ts.
 *
 * Upstream registers the same logic twice (ComposableCow historical +
 * ComposableCowLive at startBlock "latest") to distinguish backfill from live
 * creations; here one registration covers both and `isLive` is derived from
 * `context.chain.isRealtime`.
 *
 * For deterministic types (TWAP, StopLoss, CirclesBackingOrder), precomputeAndDiscover
 * computes all UIDs, fetches their status from the API, upserts discrete orders, and marks
 * allCandidatesKnown=true. Non-deterministic types are left for the OrderDiscoveryPoller
 * block handler to discover at live sync.
 *
 * KNOWN LIMITATION — Off-chain cancellation gap:
 *   Orders cancelled via the CoW Orderbook API's DELETE endpoint (off-chain
 *   soft cancel) are NOT detected after the initial fetch. The standard
 *   on-chain cancellation path is detected via SingleOrderNotAuthed
 *   (OrderDiscoveryPoller) and the CancellationWatcher.
 */

import { indexer } from "envio";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { getOrderTypeFromHandler, isNonDeterministic, type OrderType } from "../utils/order-types.js";
import { decodeStaticInput } from "../decoders/index.js";
import { precomputeAndDiscover } from "../helpers/uidPrecompute.js";
import { circlesImmutables } from "../effects/rpc.js";
import { log } from "../helpers/logger.js";

// ─── Shared helper — generator insert logic ─────────────────────────────────

async function insertGenerator(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  // True when this generator is created during live sync. Live generators have
  // no pre-creation history and are owned by the realtime poller from birth, so
  // they never need an OwnerBackfill drain.
  isLive: boolean,
): Promise<{
  generatorId: string;
  ownerAddress: Hex;
  chainId: number;
  decodedParams: Record<string, string> | null;
  orderType: OrderType;
}> {
  const { owner, params } = event.params;
  const { handler, salt, staticInput } = params;

  const encoded = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "handler", type: "address" },
          { name: "salt", type: "bytes32" },
          { name: "staticInput", type: "bytes" },
        ],
      },
    ],
    [{ handler: handler as Hex, salt: salt as Hex, staticInput: staticInput as Hex }],
  );
  const hash = keccak256(encoded);

  const ownerAddress = owner.toLowerCase() as `0x${string}`;
  const chainId = event.chainId as number;
  const generatorId = `${chainId}_${event.block.number}_${event.logIndex}`;
  const orderType = getOrderTypeFromHandler(handler, chainId);

  if (orderType === "Unknown") {
    log("warn", "composableCow:unknownHandler", { handler, chainId, event: generatorId });
  } else {
    log("info", "composableCow:created", { event: generatorId, chainId, orderType, block: String(event.block.number) });
  }

  // Decode staticInput; for CirclesBackingOrder, also merge in handler immutables.
  let decodedParams: Record<string, string> | null = null;
  let decodeError: string | null = null;

  if (orderType !== "Unknown") {
    try {
      const decoded = (decodeStaticInput(orderType, staticInput as Hex) ?? null) as
        | Record<string, unknown>
        | null;
      // Resolve t0=0: the contract uses block.timestamp when staticInput has t0=0.
      // Store the resolved value so precompute always has the real start time.
      if (
        decoded &&
        orderType === "TWAP" &&
        BigInt((decoded.t0 as bigint) ?? 0n) === 0n
      ) {
        decoded.t0 = BigInt(event.block.timestamp);
      }
      decodedParams = decoded
        ? (JSON.parse(
            JSON.stringify(decoded, (_key, value) =>
              typeof value === "bigint" ? value.toString() : value,
            ),
          ) as Record<string, string>)
        : null;

      if (orderType === "CirclesBackingOrder" && decodedParams) {
        const immutablesJson = await context.effect(circlesImmutables, {
          chainId,
          handler: handler.toLowerCase(),
        });
        if (immutablesJson) {
          const { sellToken, sellAmount } = JSON.parse(immutablesJson) as {
            sellToken: string;
            sellAmount: string;
          };
          decodedParams = { ...decodedParams, sellToken, sellAmount };
        }
      }
    } catch (err) {
      log("warn", "composableCow:decodeFailed", { event: generatorId, orderType, err: String(err) });
      decodedParams = null;
      decodeError = "invalid_static_input";
    }
  }

  // Resolve EOA: look up OwnerMapping in case owner is a known proxy (CoWShed).
  // For Aave adapters the mapping won't exist yet; the settlement handler backfills later.
  const mapping = await context.OwnerMapping.get(`${chainId}_${ownerAddress}`);
  const resolvedOwner = mapping ? mapping.owner : ownerAddress;
  const ownerAddressType = mapping ? mapping.addressType : undefined;

  // Upsert transaction row (idempotent — multiple events may share a tx)
  context.Transaction.set({
    id: `${chainId}_${event.transaction.hash}`,
    hash: event.transaction.hash,
    chainId,
    blockNumber: BigInt(event.block.number),
    blockTimestamp: BigInt(event.block.timestamp),
  });

  // Insert-only (upstream onConflictDoNothing): a replay must not reset flags
  // like historyBackfilled that other handlers may have flipped.
  const existing = await context.ConditionalOrderGenerator.get(generatorId);
  if (!existing) {
    context.ConditionalOrderGenerator.set({
      id: generatorId,
      chainId,
      owner: ownerAddress,
      resolvedOwner,
      ownerAddressType,
      handler: handler.toLowerCase(),
      salt,
      staticInput,
      hash,
      orderType,
      status: "Active",
      decodedParams,
      decodeError: decodeError ?? undefined,
      txHash: event.transaction.hash,
      allCandidatesKnown: false,
      nextCheckBlock: BigInt(event.block.number),
      lastCheckBlock: undefined,
      lastPollResult: undefined,
      nextCheckTimestamp: undefined,
      consecutiveTryNextBlock: 0,
      // Only non-deterministic generators created during historical backfill need an
      // OwnerBackfill drain. Deterministic types are fully handled by precompute at
      // creation, and live-created generators are owned by the realtime poller.
      historyBackfilled: isLive || !isNonDeterministic(orderType),
    });
  }

  return { generatorId, ownerAddress, chainId, decodedParams, orderType };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

indexer.onEvent(
  { contract: "ComposableCoW", event: "ConditionalOrderCreated" },
  async ({ event, context }) => {
    const isLive = context.chain.isRealtime;
    const { generatorId, ownerAddress, chainId, decodedParams, orderType } =
      await insertGenerator(event, context, isLive);

    // Pre-compute UIDs for deterministic order types (TWAP, StopLoss, CirclesBackingOrder).
    // Fetches status from API by UID, upserts discrete orders, and
    // deactivates the generator if all orders are already terminal.
    await precomputeAndDiscover(
      context, chainId, generatorId, ownerAddress, orderType, decodedParams,
      BigInt(event.block.timestamp),
    );
  },
);
