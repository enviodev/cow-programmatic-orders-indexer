/**
 * OrderDiscoveryPoller — polls getTradeableOrderWithSignature for any active
 * generator where allCandidatesKnown=false. Normally only non-deterministic
 * types, but also serves as fallback for deterministic types whose precompute
 * failed. Ported from the upstream ponder indexer's orderDiscoveryPoller.ts.
 */

import { indexer } from "envio";
import {
  COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID,
  RECHECK_INTERVAL_BLOCKS_BY_CHAIN_ID,
} from "../data.js";
import {
  DEFAULT_MAX_GENERATORS_PER_BLOCK,
  DEFAULT_RECHECK_INTERVAL_BLOCKS,
  TRY_NEXT_BLOCK_WARMUP_THRESHOLD,
  TRY_NEXT_BLOCK_COOLDOWN_THRESHOLD,
  TRY_NEXT_BLOCK_BACKOFF_WARMUP,
  TRY_NEXT_BLOCK_BACKOFF_MID,
  TRY_NEXT_BLOCK_BACKOFF_COLD,
} from "../constants.js";
import { pollTradeableOrders, type PollOrderResult } from "../effects/rpc.js";
import { computeOrderUid, KIND_SELL, type GPv2OrderData } from "../helpers/orderUid.js";
import { log } from "../helpers/logger.js";
import { blockHandlerInterval, blockTimestamp, isTest, pollerBlockFilter, resolveCap } from "../helpers/blockHandlerShared.js";
import { type OrderType } from "../utils/order-types.js";
import type { Hex } from "viem";

const SINGLE_SHOT_NON_DETERMINISTIC: readonly OrderType[] = ["GoodAfterTime", "TradeAboveThreshold"];
const BLOCK_NEVER = 2n ** 63n - 1n; // sentinel for epoch-scheduled generators (PollTryAtEpoch)

async function updateGeneratorPollState(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  generatorId: string,
  currentBlock: bigint,
  fields: {
    nextCheckBlock: bigint | undefined;
    lastPollResult: string;
    nextCheckTimestamp: bigint | undefined;
    allCandidatesKnown?: boolean;
    consecutiveTryNextBlock?: number;
  },
): Promise<void> {
  const generator = await context.ConditionalOrderGenerator.get(generatorId);
  if (!generator) return;
  context.ConditionalOrderGenerator.set({
    ...generator,
    nextCheckBlock: fields.nextCheckBlock,
    nextCheckTimestamp: fields.nextCheckTimestamp,
    lastCheckBlock: currentBlock,
    lastPollResult: fields.lastPollResult,
    ...(fields.allCandidatesKnown !== undefined
      ? { allCandidatesKnown: fields.allCandidatesKnown }
      : {}),
    ...(fields.consecutiveTryNextBlock !== undefined
      ? { consecutiveTryNextBlock: fields.consecutiveTryNextBlock }
      : {}),
  });
}

if (!isTest) {
  indexer.onBlock(
    {
      name: "OrderDiscoveryPoller",
      where: ({ chain }) => pollerBlockFilter(chain.id),
    },
    async ({ block, context }) => {
      // startBlock "latest" upstream — only poll once caught up to the tip.
      if (!context.chain.isRealtime) return;

      const chainId = context.chain.id;
      const composableCowAddress = COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID[chainId];
      if (!composableCowAddress) return;

      // Per-chain recheck cadence (derived from ChainConfig.orderbookPollInterval).
      const recheckInterval =
        RECHECK_INTERVAL_BLOCKS_BY_CHAIN_ID[chainId] ?? DEFAULT_RECHECK_INTERVAL_BLOCKS;

      const currentBlock = BigInt(block.number);
      const currentTimestamp = await blockTimestamp(context, block);

      const maxGeneratorsPerBlock = resolveCap(
        `MAX_GENERATORS_PER_BLOCK_${chainId}`,
        DEFAULT_MAX_GENERATORS_PER_BLOCK,
      );

      // Upstream: WHERE ... AND (nextCheckBlock <= cur OR nextCheckTimestamp <= ts).
      // getWhere is AND-only, so run the two branches separately and merge.
      const base = {
        status: { _eq: "Active" as const },
        allCandidatesKnown: { _eq: false },
      };
      const [byBlock, byEpoch] = await Promise.all([
        context.ConditionalOrderGenerator.getWhere({
          ...base,
          nextCheckBlock: { _lte: currentBlock },
        }),
        context.ConditionalOrderGenerator.getWhere({
          ...base,
          nextCheckTimestamp: { _lte: currentTimestamp },
        }),
      ]);
      const byId = new Map<string, (typeof byBlock)[number]>();
      for (const g of [...byBlock, ...byEpoch]) byId.set(g.id, g);

      const dueOrders = [...byId.values()]
        .sort((a, b) => Number((a.lastCheckBlock ?? 0n) - (b.lastCheckBlock ?? 0n)))
        .slice(0, maxGeneratorsPerBlock);

      if (dueOrders.length === 0) return;

      if (!context.isPreload) {
        log("info", "OrderDiscoveryPoller:ENTER", { block: String(currentBlock), chainId, due: dueOrders.length });
      }

      const resultsJson = await context.effect(pollTradeableOrders, {
        ordersJson: JSON.stringify(
          dueOrders.map((o) => ({
            owner: o.owner,
            handler: o.handler,
            salt: o.salt,
            staticInput: o.staticInput,
          })),
        ),
      });
      const results = JSON.parse(resultsJson) as PollOrderResult[];

      let neverCount = 0;
      let successCount = 0;
      let backedOffCount = 0; // tryNextBlock results that exceeded the warmup threshold

      for (let i = 0; i < dueOrders.length; i++) {
        const result = results[i];
        const order = dueOrders[i]!;

        if (result === undefined || result.status === "unavailable") continue;

        if (result.status === "success") {
          const o = result.order;
          const orderData: GPv2OrderData = {
            sellToken: o.sellToken as Hex,
            buyToken: o.buyToken as Hex,
            receiver: o.receiver as Hex,
            sellAmount: BigInt(o.sellAmount),
            buyAmount: BigInt(o.buyAmount),
            validTo: o.validTo,
            appData: o.appData as Hex,
            feeAmount: BigInt(o.feeAmount),
            kind: (o.kind || KIND_SELL) as Hex,
            partiallyFillable: o.partiallyFillable,
            sellTokenBalance: o.sellTokenBalance as Hex,
            buyTokenBalance: o.buyTokenBalance as Hex,
          };
          const orderUid = computeOrderUid(chainId, orderData, order.owner as Hex).toLowerCase();

          let possibleValidAfterTimestamp: bigint | undefined = undefined;
          const decodedParams = order.decodedParams as Record<string, string> | undefined;
          if (order.orderType === "TWAP" && decodedParams) {
            const t0 = BigInt(decodedParams["t0"] ?? "0");
            const t = BigInt(decodedParams["t"] ?? "0");
            if (t0 > 0n && t > 0n) {
              const partIndex = (BigInt(orderData.validTo) + 1n - t0) / t - 1n;
              possibleValidAfterTimestamp = t0 + partIndex * t;
            }
          }

          // Insert-only (upstream onConflictDoNothing).
          const candidateId = orderUid;
          const existingCandidate = await context.CandidateDiscreteOrder.get(candidateId);
          if (!existingCandidate) {
            context.CandidateDiscreteOrder.set({
              id: candidateId,
              orderUid,
              conditionalOrderGenerator_id: order.id,
              possibleValidAfterTimestamp,
              sellAmount: orderData.sellAmount.toString(),
              buyAmount: orderData.buyAmount.toString(),
              feeAmount: orderData.feeAmount.toString(),
              validTo: BigInt(orderData.validTo),
              creationDate: currentTimestamp,
            });
          }

          const isSingleShot = SINGLE_SHOT_NON_DETERMINISTIC.includes(order.orderType as OrderType);
          await updateGeneratorPollState(context, order.id, currentBlock, {
            nextCheckBlock: currentBlock + recheckInterval,
            lastPollResult: "success",
            nextCheckTimestamp: undefined,
            allCandidatesKnown: isSingleShot ? true : undefined,
            consecutiveTryNextBlock: 0,
          });
          successCount++;
        } else {
          const pollResult = result.pollResult;

          switch (pollResult.type) {
            case "tryNextBlock": {
              const consecutive = order.consecutiveTryNextBlock + 1;
              const backoff =
                consecutive > TRY_NEXT_BLOCK_COOLDOWN_THRESHOLD ? TRY_NEXT_BLOCK_BACKOFF_COLD
                : consecutive > TRY_NEXT_BLOCK_WARMUP_THRESHOLD ? TRY_NEXT_BLOCK_BACKOFF_MID
                : TRY_NEXT_BLOCK_BACKOFF_WARMUP;
              if (consecutive > TRY_NEXT_BLOCK_WARMUP_THRESHOLD) backedOffCount++;
              await updateGeneratorPollState(context, order.id, currentBlock, {
                nextCheckBlock: currentBlock + backoff,
                lastPollResult: "tryNextBlock",
                nextCheckTimestamp: undefined,
                consecutiveTryNextBlock: consecutive,
              });
              break;
            }

            case "tryAtBlock": {
              const atBlock = BigInt(pollResult.blockNumber);
              await updateGeneratorPollState(context, order.id, currentBlock, {
                nextCheckBlock: atBlock > currentBlock ? atBlock : currentBlock + 1n,
                lastPollResult: "tryAtBlock",
                nextCheckTimestamp: undefined,
                consecutiveTryNextBlock: 0,
              });
              break;
            }

            case "tryAtEpoch":
              await updateGeneratorPollState(context, order.id, currentBlock, {
                nextCheckBlock: BLOCK_NEVER,
                lastPollResult: "tryAtEpoch",
                nextCheckTimestamp: BigInt(pollResult.timestamp),
                consecutiveTryNextBlock: 0,
              });
              break;

            case "never": {
              const generator = await context.ConditionalOrderGenerator.get(order.id);
              if (generator) {
                context.ConditionalOrderGenerator.set({
                  ...generator,
                  status: "Completed",
                  lastCheckBlock: currentBlock,
                  lastPollResult: `pollNever:${pollResult.reason}`,
                  consecutiveTryNextBlock: 0,
                  updatedAtBlock: currentBlock,
                });
              }
              if (!context.isPreload) {
                log("info", "OrderDiscoveryPoller:NEVER", { block: String(currentBlock), chainId, generatorId: order.id, reason: pollResult.reason });
              }
              neverCount++;
              break;
            }

            case "cancelled": {
              const generator = await context.ConditionalOrderGenerator.get(order.id);
              if (generator) {
                context.ConditionalOrderGenerator.set({
                  ...generator,
                  status: "Cancelled",
                  lastCheckBlock: currentBlock,
                  lastPollResult: "cancelled:SingleOrderNotAuthed",
                  consecutiveTryNextBlock: 0,
                  updatedAtBlock: currentBlock,
                });
              }
              if (!context.isPreload) {
                log("info", "OrderDiscoveryPoller:CANCELLED", { block: String(currentBlock), chainId, generatorId: order.id });
              }
              break;
            }
          }
        }
      }

      const capped = dueOrders.length === maxGeneratorsPerBlock;
      if (!context.isPreload) {
        log("info", "OrderDiscoveryPoller:DONE", { block: String(currentBlock), chainId, due: dueOrders.length, success: successCount, never: neverCount, backedOff: backedOffCount, capped });
      }
    },
  );
}
