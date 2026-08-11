/**
 * CancellationWatcher — OrderDiscoveryPoller skips generators with
 * allCandidatesKnown=true (deterministic types: TWAP, StopLoss,
 * CirclesBackingOrder), so SingleOrderNotAuthed is never observed for them.
 * This handler closes that gap by reading ComposableCoW.singleOrders(owner, hash)
 * on a DETERMINISTIC_CANCEL_SWEEP_INTERVAL cadence. A `false` result means the
 * owner called remove() on-chain → flip to Cancelled, which lets the
 * CandidateConfirmer/OrderStatusTracker parent-cancelled cascade reconcile the
 * child rows on the next block. Ported from the upstream ponder indexer's
 * cancellationWatcher.ts (supersedes this repo's old RemovalPoller).
 */

import { indexer } from "envio";
import { COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID } from "../data.js";
import {
  DEFAULT_MAX_GENERATORS_PER_BLOCK,
  DETERMINISTIC_CANCEL_SWEEP_INTERVAL,
} from "../constants.js";
import { checkOrdersActive } from "../effects/rpc.js";
import { log } from "../helpers/logger.js";
import { blockHandlerInterval, isTest, pollerBlockFilter, resolveCap } from "../helpers/blockHandlerShared.js";

if (!isTest) {
  indexer.onBlock(
    {
      name: "CancellationWatcher",
      where: ({ chain }) => pollerBlockFilter(chain.id),
    },
    async ({ block, context }) => {
      if (!context.chain.isRealtime) return; // startBlock "latest" upstream

      const chainId = context.chain.id;
      const composableCowAddress = COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID[chainId];
      if (!composableCowAddress) return;

      const currentBlock = BigInt(block.number);

      const maxGeneratorsPerBlock = resolveCap(
        `MAX_GENERATORS_PER_BLOCK_${chainId}`,
        DEFAULT_MAX_GENERATORS_PER_BLOCK,
      );

      // Upstream also matches nextCheckBlock IS NULL; rows always get a
      // nextCheckBlock at insert/precompute, so the _lte branch suffices.
      const due = await context.ConditionalOrderGenerator.getWhere({
        status: { _eq: "Active" },
        allCandidatesKnown: { _eq: true },
        nextCheckBlock: { _lte: currentBlock },
      });

      const dueGenerators = due
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .sort((a: any, b: any) => Number((a.lastCheckBlock ?? 0n) - (b.lastCheckBlock ?? 0n)))
        .slice(0, maxGeneratorsPerBlock);

      if (dueGenerators.length === 0) return;

      if (!context.isPreload) {
        log("info", "CancellationWatcher:ENTER", { block: String(currentBlock), chainId, due: dueGenerators.length });
      }

      const resultsJson = await context.effect(checkOrdersActive, {
        ordersJson: JSON.stringify(
          dueGenerators.map((g: { owner: string; hash: string }) => ({ owner: g.owner, hash: g.hash })),
        ),
        chainId,
      });
      const results = JSON.parse(resultsJson) as Array<{
        hash: string;
        owner: string;
        active: boolean;
        error?: string;
      }>;

      let cancelledCount = 0;
      let stillActiveCount = 0;
      let errorCount = 0;

      for (let i = 0; i < dueGenerators.length; i++) {
        const result = results[i];
        const gen = dueGenerators[i]!;

        if (result === undefined || result.error) {
          errorCount++;
          // Leave state untouched — retry next sweep cycle.
          continue;
        }

        if (!result.active) {
          context.ConditionalOrderGenerator.set({
            ...gen,
            status: "Cancelled",
            lastCheckBlock: currentBlock,
            lastPollResult: "cancelled:removeMapping",
            nextCheckBlock: undefined,
          });
          if (!context.isPreload) {
            log("info", "CancellationWatcher:CANCELLED", { block: String(currentBlock), chainId, generatorId: gen.id, orderType: gen.orderType });
          }
          cancelledCount++;
        } else {
          context.ConditionalOrderGenerator.set({
            ...gen,
            lastCheckBlock: currentBlock,
            nextCheckBlock: currentBlock + DETERMINISTIC_CANCEL_SWEEP_INTERVAL,
            lastPollResult: "sweep:stillAuthorized",
          });
          stillActiveCount++;
        }
      }

      if (!context.isPreload) {
        log("info", "CancellationWatcher:DONE", { block: String(currentBlock), chainId, due: dueGenerators.length, cancelled: cancelledCount, stillActive: stillActiveCount, errors: errorCount });
      }
    },
  );
}
