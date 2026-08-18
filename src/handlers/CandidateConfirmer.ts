/**
 * CandidateConfirmer — checks if candidate discrete orders exist on the
 * Orderbook API and promotes them to DiscreteOrder. Ported from the upstream
 * ponder indexer's candidateConfirmer.ts.
 */

import { indexer } from "envio";
import type { Hex } from "viem";
import {
  BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS,
  ORDERBOOK_BATCH_TIMEOUT_MS,
} from "../constants.js";
import { fetchOrderStatusByUids, fetchOwnerOrderStatuses } from "../helpers/orderbook/client.js";
import { toDiscreteStatus } from "../helpers/orderbook/types.js";
import { withTimeout } from "../helpers/withTimeout.js";
import { bumpGeneratorsUpdatedAt } from "../helpers/updatedAtBlock.js";
import { log } from "../helpers/logger.js";
import { blockHandlerInterval, blockTimestamp, isTest, nextHexBucket, pollerBlockFilter } from "../helpers/blockHandlerShared.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CandidateRow = any;

// Promote a candidate into DiscreteOrder. insertOnly mirrors upstream's
// onConflictDoNothing (an existing terminal row wins); otherwise the API
// status/executed/promotedAt overwrite (onConflictDoUpdate). Bumps the parent
// generator's sync cursor only when a row was actually inserted or changed —
// insertOnly conflicts are no-ops and must not bump.
async function promoteCandidate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  candidate: CandidateRow,
  status: string,
  executedSellAmount: string | null,
  executedBuyAmount: string | null,
  promotedAt: bigint,
  currentBlock: bigint,
  insertOnly: boolean,
): Promise<void> {
  const id = candidate.orderUid;
  const existing = await context.DiscreteOrder.get(id);
  if (existing) {
    if (insertOnly) return;
    context.DiscreteOrder.set({
      ...existing,
      status: toDiscreteStatus(status),
      executedSellAmount: executedSellAmount ?? undefined,
      executedBuyAmount: executedBuyAmount ?? undefined,
      promotedAt,
      updatedAtBlock: currentBlock,
    });
  } else {
    context.DiscreteOrder.set({
      id,
      orderUid: candidate.orderUid,
      conditionalOrderGenerator_id: candidate.conditionalOrderGenerator_id,
      status: toDiscreteStatus(status),
      sellAmount: candidate.sellAmount,
      buyAmount: candidate.buyAmount,
      feeAmount: candidate.feeAmount,
      validTo: candidate.validTo,
      creationDate: candidate.creationDate,
      executedSellAmount: executedSellAmount ?? undefined,
      executedBuyAmount: executedBuyAmount ?? undefined,
      promotedAt,
      updatedAtBlock: currentBlock,
    });
  }
  await bumpGeneratorsUpdatedAt(context, [candidate.conditionalOrderGenerator_id], currentBlock);
}

if (!isTest) {
  indexer.onBlock(
    {
      name: "CandidateConfirmer",
      where: ({ chain }) => pollerBlockFilter(chain.id),
    },
    async ({ block, context }) => {
      if (!context.chain.isRealtime) return; // startBlock "latest" upstream

      const chainId = context.chain.id;
      const currentTimestamp = await blockTimestamp(context, block);

      // Bounded scan: one orderUid-nibble bucket of candidates per firing
      // (~1/16 of the table). Parent generators resolve via batched .get —
      // no all-cancelled-generators table scan.
      const bucket = nextHexBucket(`candconf:${chainId}`);
      const candidates = await context.CandidateDiscreteOrder.getWhere({
        orderUid: bucket,
      });
      if (candidates.length === 0) return;

      const generators = await Promise.all(
        candidates.map((c: CandidateRow) =>
          context.ConditionalOrderGenerator.get(c.conditionalOrderGenerator_id),
        ),
      );
      const genById = new Map<string, unknown>();
      candidates.forEach((c: CandidateRow, i: number) => genById.set(c.conditionalOrderGenerator_id, generators[i]));

      // Parent-cancelled cascade: candidates whose parent generator flipped to
      // Cancelled never hit the orderbook, so skip the API and promote them
      // directly to DiscreteOrder as cancelled (with a /by_uids preflight).
      const orphanCandidates = candidates.filter((c: CandidateRow) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = genById.get(c.conditionalOrderGenerator_id) as any;
        return g && g.status === "Cancelled";
      });

      if (orphanCandidates.length > 0) {
        let preflightStatuses: Awaited<ReturnType<typeof fetchOrderStatusByUids>>;
        try {
          preflightStatuses = await withTimeout(
            fetchOrderStatusByUids(context, orphanCandidates.map((c: CandidateRow) => c.orderUid)),
            ORDERBOOK_BATCH_TIMEOUT_MS,
            "CandidateConfirmer:cascade:preflight",
          );
        } catch {
          preflightStatuses = new Map();
        }

        for (const c of orphanCandidates) {
          const apiEntry = preflightStatuses.get(c.orderUid);
          await promoteCandidate(
            context, c,
            apiEntry?.status ?? "cancelled",
            apiEntry?.executedSellAmount ?? null,
            apiEntry?.executedBuyAmount ?? null,
            currentTimestamp,
            BigInt(block.number),
            true, // onConflictDoNothing — an existing terminal row wins
          );
          context.CandidateDiscreteOrder.deleteUnsafe(c.id);
        }

        if (!context.isPreload) {
          log("info", "CandidateConfirmer:parent_cancelled", { block: String(block.number), chainId, parentCancelled: orphanCandidates.length, preflightKnown: preflightStatuses.size });
        }
      }

      // Unconfirmed candidates in this bucket: skip TWAP parts whose validity
      // window hasn't started and already-expired candidates (stale path below).
      const orphanIds = new Set(orphanCandidates.map((c: CandidateRow) => c.id));
      const unconfirmed = candidates.filter(
        (c: CandidateRow) =>
          !orphanIds.has(c.id) &&
          (c.possibleValidAfterTimestamp == null || c.possibleValidAfterTimestamp <= currentTimestamp) &&
          (c.validTo == null || c.validTo > currentTimestamp),
      );

      if (unconfirmed.length === 0) return;

      const uids = unconfirmed.map((c: CandidateRow) => c.orderUid);
      const statuses = await fetchOrderStatusByUids(context, uids);

      let confirmed = 0;
      for (const candidate of unconfirmed) {
        const orderbookEntry = statuses.get(candidate.orderUid);
        if (!orderbookEntry) continue; // not on API yet — retry next block

        await promoteCandidate(
          context, candidate,
          orderbookEntry.status,
          orderbookEntry.executedSellAmount,
          orderbookEntry.executedBuyAmount,
          currentTimestamp,
          BigInt(block.number),
          false, // onConflictDoUpdate
        );
        context.CandidateDiscreteOrder.deleteUnsafe(candidate.id);
        confirmed++;
      }

      // Promote expired candidates — a final API check so submitted-but-expired
      // orders land in DiscreteOrder rather than disappearing silently.
      const staleAll = candidates.filter(
        (c: CandidateRow) =>
          !orphanIds.has(c.id) && c.validTo != null && c.validTo <= currentTimestamp,
      );
      const stale = staleAll.slice(0, 500);

      if (stale.length > 0) {
        const staleStatuses = await fetchOrderStatusByUids(
          context, stale.map((c: CandidateRow) => c.orderUid),
        );

        // TWAP parts can age out of /by_uids before CandidateConfirmer sees them.
        // For any missed UIDs, fall back to /account/{owner}/orders — one fetch
        // per unique owner.
        const missed = stale.filter((c: CandidateRow) => !staleStatuses.has(c.orderUid));
        if (missed.length > 0) {
          const generatorIds = [...new Set(missed.map((c: CandidateRow) => c.conditionalOrderGenerator_id))];
          const ownerByGeneratorId = new Map<string, Hex>();
          for (const gid of generatorIds) {
            const gen = await context.ConditionalOrderGenerator.get(gid);
            if (gen) ownerByGeneratorId.set(gid as string, gen.owner as Hex);
          }

          const missedByOwner = new Map<Hex, Set<string>>();
          for (const c of missed) {
            const owner = ownerByGeneratorId.get(c.conditionalOrderGenerator_id);
            if (!owner) continue;
            const ownerKey = owner.toLowerCase() as Hex;
            if (!missedByOwner.has(ownerKey)) missedByOwner.set(ownerKey, new Set());
            missedByOwner.get(ownerKey)!.add(c.orderUid);
          }

          for (const [owner, ownerMissedUids] of missedByOwner) {
            try {
              const ownerStatuses = await withTimeout(
                fetchOwnerOrderStatuses(context, owner),
                BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS,
                "CandidateConfirmer:stale:accountFallback",
              );
              for (const [uid, info] of ownerStatuses) {
                if (ownerMissedUids.has(uid)) staleStatuses.set(uid, info);
              }
            } catch (err) {
              log("warn", "CandidateConfirmer:accountFallback_failed", { block: String(block.number), chainId, owner, err: err instanceof Error ? err.message : String(err) });
            }
          }
        }

        for (const c of stale) {
          const entry = staleStatuses.get(c.orderUid);
          await promoteCandidate(
            context, c,
            entry?.status ?? "expired",
            entry?.executedSellAmount ?? null,
            entry?.executedBuyAmount ?? null,
            currentTimestamp,
            BigInt(block.number),
            true, // onConflictDoNothing
          );
          context.CandidateDiscreteOrder.deleteUnsafe(c.id);
        }
      }

      if ((confirmed > 0 || stale.length > 0) && !context.isPreload) {
        log("info", "CandidateConfirmer:DONE", { block: String(block.number), chainId, candidates: unconfirmed.length, confirmed, expired: stale.length });
      }
    },
  );
}
