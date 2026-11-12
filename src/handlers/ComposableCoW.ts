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
import { getOrderTypeFromHandler, isNonDeterministic, isOwnerBackfillEligible } from "../utils/order-types.js";
import { decodeStaticInput } from "../decoders/index.js";
import {
  precomputeAndDiscover,
  serializeDecodedParams,
  type GeneratorDecodedOrder,
} from "../helpers/uidPrecompute.js";
import { ZERO_TOTALS } from "../helpers/executedAmounts.js";
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
  decodedOrder: GeneratorDecodedOrder;
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
  const generatorId = `${event.block.number}_${event.logIndex}`;
  const orderType = getOrderTypeFromHandler(handler, chainId);

  if (orderType === "Unknown") {
    log("warn", "composableCow:unknownHandler", { handler, chainId, event: generatorId });
  } else {
    log("info", "composableCow:created", { event: generatorId, chainId, orderType, block: String(event.block.number) });
  }

  // Decode staticInput into native values; for CirclesBackingOrder, also merge
  // in handler immutables. Bigints are serialized only for storage, below.
  let decodedOrder: GeneratorDecodedOrder = { orderType, decodedParams: null };
  let decodeError: string | null = null;

  if (orderType !== "Unknown") {
    try {
      const decoded = decodeStaticInput(orderType, staticInput as Hex);
      // Resolve t0=0 before storing or calculating TWAP parts: the contract uses
      // block.timestamp when staticInput has t0=0.
      if (decoded?.orderType === "TWAP" && decoded.decodedParams.t0 === 0n) {
        decoded.decodedParams.t0 = BigInt(event.block.timestamp);
      }

      if (decoded?.orderType === "CirclesBackingOrder") {
        // Throws on RPC failure (not cached) → handled as a decode failure, like upstream.
        const immutablesJson: string | null = await context.effect(circlesImmutables, {
          handler: handler.toLowerCase(),
        });
        if (!immutablesJson) throw new Error("circlesImmutables unavailable");
        const immutables = JSON.parse(immutablesJson) as { sellToken: Hex; sellAmount: string };
        decodedOrder = {
          orderType: decoded.orderType,
          decodedParams: {
            ...decoded.decodedParams,
            sellToken: immutables.sellToken,
            sellAmount: BigInt(immutables.sellAmount),
          },
        };
      } else if (decoded) {
        decodedOrder = decoded;
      }
    } catch (err) {
      log("warn", "composableCow:decodeFailed", { event: generatorId, orderType, err: String(err) });
      decodedOrder = { orderType, decodedParams: null };
      decodeError = "invalid_static_input";
    }
  }

  // Resolve EOA: look up OwnerMapping in case owner is a known proxy (CoWShed).
  // For Aave adapters the mapping won't exist yet; the settlement handler backfills later.
  const mapping = await context.OwnerMapping.get(ownerAddress);
  const resolvedOwner = mapping ? mapping.owner : ownerAddress;
  const ownerAddressType = mapping ? mapping.addressType : undefined;

  // Upsert transaction row (idempotent — multiple events may share a tx)
  context.Transaction.set({
    id: event.transaction.hash,
    hash: event.transaction.hash,
    blockNumber: BigInt(event.block.number),
    blockTimestamp: BigInt(event.block.timestamp),
  });

  // Insert-only (upstream onConflictDoNothing): a replay must not reset flags
  // like historyBackfilled that other handlers may have flipped.
  const existing = await context.ConditionalOrderGenerator.get(generatorId);
  if (!existing) {
    context.ConditionalOrderGenerator.set({
      id: generatorId,
      owner: ownerAddress,
      resolvedOwner,
      ownerAddressType,
      handler: handler.toLowerCase(),
      salt,
      staticInput,
      hash,
      orderType,
      status: "Active",
      decodedParams: serializeDecodedParams(decodedOrder.decodedParams) ?? undefined,
      decodeError: decodeError ?? undefined,
      additionalData: orderType === "TWAP" ? ZERO_TOTALS : undefined,
      txHash: event.transaction.hash,
      allCandidatesKnown: false,
      nextCheckBlock: BigInt(event.block.number),
      lastCheckBlock: undefined,
      lastPollResult: undefined,
      nextCheckTimestamp: undefined,
      consecutiveTryNextBlock: 0,
      // Only non-deterministic generators created during historical backfill need an
      // OwnerBackfill drain. Deterministic types are fully handled by precompute at
      // creation (live) or by PrecomputeBackfiller at the tip (historical).
      // Unknown and CowAmmConstantProduct are excluded from the backfill entirely
      // (OWNER_BACKFILL_EXCLUDED), so they're also born "already backfilled".
      historyBackfilled: isLive || !isOwnerBackfillEligible(orderType),
      // Historical deterministic generators defer their UID precompute to the
      // tip (PrecomputeBackfiller) so the event backfill never blocks on
      // orderbook I/O. Live ones precompute inline, exactly like upstream.
      precomputePending: !isLive && !isNonDeterministic(orderType),
      updatedAtBlock: BigInt(event.block.number),
    });
  }

  return { generatorId, ownerAddress, decodedOrder };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

const isTestEnv = typeof process !== "undefined" && !!process.env.VITEST;

indexer.onEvent(
  { contract: "ComposableCoW", event: "ConditionalOrderCreated" },
  async ({ event, context }) => {
    // Tests process pinned historical ranges but assert live semantics.
    const isLive = context.chain.isRealtime || isTestEnv;
    const { generatorId, ownerAddress, decodedOrder } =
      await insertGenerator(event, context, isLive);

    // Pre-compute UIDs for deterministic order types (TWAP, StopLoss,
    // CirclesBackingOrder) — INLINE only at realtime, exactly like upstream's
    // live handler. Historical generators defer to PrecomputeBackfiller at the
    // tip so the chain backfill never blocks on orderbook I/O.
    if (isLive) {
      await precomputeAndDiscover(
        context, generatorId, ownerAddress, decodedOrder,
        BigInt(event.block.timestamp), BigInt(event.block.number),
      );
    }
  },
);
