/**
 * OrderStatusTracker — polls the API for status updates on open discrete
 * orders. Expires past validTo. Ported from the upstream ponder indexer's
 * orderStatusTracker.ts.
 */

import { indexer } from "envio";
import {
  DEFAULT_MAX_DISCRETE_ORDERS_PER_BLOCK,
  DEFAULT_REORG_SAFETY_WINDOW_SECONDS,
} from "../constants.js";
import { REORG_SAFETY_WINDOW_SECONDS } from "../data.js";
import { fetchOrderStatusByUids } from "../helpers/orderbook/client.js";
import { toDiscreteStatus } from "../helpers/orderbook/types.js";
import { bumpGeneratorsUpdatedAt } from "../helpers/updatedAtBlock.js";
import { refreshTwapExecutedTotals } from "../helpers/executedAmounts.js";
import { log } from "../helpers/logger.js";
import { blockHandlerInterval, blockTimestamp, isTest, nextHexBucket, pollerBlockFilter, resolveCap } from "../helpers/blockHandlerShared.js";

const VALID_DISCRETE_STATUSES = new Set(["fulfilled", "unfilled", "expired", "cancelled"]);

if (!isTest) {
  indexer.onBlock(
    {
      name: "OrderStatusTracker",
      where: ({ chain }) => pollerBlockFilter(chain.id),
    },
    async ({ block, context }) => {
      if (!context.chain.isRealtime) return; // startBlock "latest" upstream

      const chainId = context.chain.id;
      const currentBlock = BigInt(block.number);
      const currentTimestamp = await blockTimestamp(context, block);

      const maxOrdersPerBlock = resolveCap(
        `MAX_DISCRETE_ORDERS_PER_BLOCK_${chainId}`,
        DEFAULT_MAX_DISCRETE_ORDERS_PER_BLOCK,
      );

      // Bounded scan: one orderUid-nibble bucket of open orders per firing.
      const bucket = nextHexBucket(`ost:${chainId}`);
      const allOpen = await context.DiscreteOrder.getWhere({
        status: { _eq: "Open" },
        orderUid: bucket,
      });
      // Oldest-promoted first (upstream ORDER BY promotedAt ASC — nulls last in PG).
      const openOrders = allOpen
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .sort((a: any, b: any) => {
          if (a.promotedAt == null && b.promotedAt == null) return 0;
          if (a.promotedAt == null) return 1;
          if (b.promotedAt == null) return -1;
          return Number(a.promotedAt - b.promotedAt);
        })
        .slice(0, maxOrdersPerBlock);

      if (openOrders.length > 0) {
        const uids = openOrders.map((o: { orderUid: string }) => o.orderUid);
        const statuses = await fetchOrderStatusByUids(context, uids);

        let updated = 0;
        const updatedGeneratorIds: string[] = [];
        for (const order of openOrders) {
          const info = statuses.get(order.orderUid);
          if (!info || !VALID_DISCRETE_STATUSES.has(info.status)) continue;
          // promotedAt intentionally preserved across status updates.
          // Statuses served from the cache can carry null executed amounts —
          // coalesce so they never erase values from an earlier fresh fetch.
          context.DiscreteOrder.set({
            ...order,
            status: toDiscreteStatus(info.status),
            executedSellAmount: info.executedSellAmount ?? order.executedSellAmount,
            executedBuyAmount: info.executedBuyAmount ?? order.executedBuyAmount,
            executedFee: info.executedFee ?? order.executedFee,
            updatedAtBlock: currentBlock,
          });
          updatedGeneratorIds.push(order.conditionalOrderGenerator_id);
          updated++;
        }
        await bumpGeneratorsUpdatedAt(context, updatedGeneratorIds, currentBlock);
        await refreshTwapExecutedTotals(context, updatedGeneratorIds);

        if (updated > 0 && !context.isPreload) {
          log("info", "OrderStatusTracker:DONE", { block: String(block.number), chainId, open: openOrders.length, updated });
        }
      }

      // ── Soft-terminal re-poll (reorg self-healing — COW-1183) ──────────────
      // A terminal status written before a fork block can outlive the reorg
      // (the durable caches sit outside the rollback journal, and terminal
      // rows were never re-fetched). Terminal rows are therefore re-polled
      // until the trust rule (orderbook/trust.ts) hardens them:
      // fetchOrderStatusByUids serves hardened rows straight from cache, so
      // only genuinely soft rows cost HTTP. Open orders keep priority under
      // the per-block cap. Cascade-cancelled rows are excluded — their truth
      // is the parent's on-chain Cancelled event and the API is silent about
      // them, so polling would ping-pong them back to open.
      const softBudget = maxOrdersPerBlock - openOrders.length;
      if (softBudget > 0) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const window =
          REORG_SAFETY_WINDOW_SECONDS[chainId] ?? DEFAULT_REORG_SAFETY_WINDOW_SECONDS;

        // validTo older than the window can't change anymore (fills are
        // impossible after validTo) — the candidate set is only
        // recently-terminal rows in this bucket. getWhere has no IS NULL, so
        // null-validTo rows are skipped (rare: writes carry validTo except
        // when the API itself returned none).
        const softAll = await context.DiscreteOrder.getWhere({
          status: { _in: ["Fulfilled", "Cancelled", "Expired"] },
          orderUid: bucket,
          validTo: { _gte: BigInt(Math.max(0, nowSeconds - window)) },
        });
        const softGens = await Promise.all(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          softAll.map((o: any) => context.ConditionalOrderGenerator.get(o.conditionalOrderGenerator_id)),
        );
        const softCandidates = softAll
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((_: any, i: number) => (softGens[i] as any)?.status !== "Cancelled")
          .slice(0, softBudget);

        if (softCandidates.length > 0) {
          const softStatuses = await fetchOrderStatusByUids(
            context,
            softCandidates.map((o: { orderUid: string }) => o.orderUid),
          );

          let reverted = 0;
          let flipped = 0;
          const touchedGeneratorIds: string[] = [];

          for (const order of softCandidates) {
            const info = softStatuses.get(order.orderUid);
            if (!info || toDiscreteStatus(info.status) === order.status) continue;
            if (info.status === "open") {
              // Reorg revert — back to open so the normal poll loop
              // re-resolves it. Skip when validTo already passed: the expiry
              // sweep owns that row. Executed amounts came from the
              // reorged-out settlement — clear them; a later fill
              // re-populates via the open-order loop.
              if (order.validTo != null && order.validTo <= currentTimestamp) continue;
              context.DiscreteOrder.set({
                ...order,
                status: "Open",
                executedSellAmount: undefined,
                executedBuyAmount: undefined,
                executedFee: undefined,
                updatedAtBlock: currentBlock,
              });
              touchedGeneratorIds.push(order.conditionalOrderGenerator_id);
              reverted++;
            } else if (VALID_DISCRETE_STATUSES.has(info.status)) {
              // Terminal-to-terminal flip. Null amounts (cache-served
              // fallbacks) keep existing values, mirroring the coalesce
              // semantics of the open-order upsert.
              context.DiscreteOrder.set({
                ...order,
                status: toDiscreteStatus(info.status),
                executedSellAmount: info.executedSellAmount ?? order.executedSellAmount,
                executedBuyAmount: info.executedBuyAmount ?? order.executedBuyAmount,
                executedFee: info.executedFee ?? order.executedFee,
                updatedAtBlock: currentBlock,
              });
              touchedGeneratorIds.push(order.conditionalOrderGenerator_id);
              flipped++;
            }
          }

          if (touchedGeneratorIds.length > 0) {
            await bumpGeneratorsUpdatedAt(context, touchedGeneratorIds, currentBlock);
            await refreshTwapExecutedTotals(context, touchedGeneratorIds);
            if (!context.isPreload) {
              log("info", "OrderStatusTracker:REORG_HEAL", { block: String(block.number), chainId, reverted, flipped });
            }
          }
        }
      }

      // Parent-cancelled cascade: any open discrete order (in this bucket)
      // whose parent generator is Cancelled and whose API state is
      // non-terminal should be cancelled from on-chain truth. Generators
      // resolve via batched .get — no all-cancelled-generators table scan.
      const stillOpen = await context.DiscreteOrder.getWhere({
        status: { _eq: "Open" },
        orderUid: bucket,
      });
      const gens = await Promise.all(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stillOpen.map((o: any) => context.ConditionalOrderGenerator.get(o.conditionalOrderGenerator_id)),
      );
      const cascadedGeneratorIds: string[] = [];
      for (let i = 0; i < stillOpen.length; i++) {
        const order = stillOpen[i];
        if (!order) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const gen = gens[i] as any;
        if (gen && gen.status === "Cancelled") {
          context.DiscreteOrder.set({ ...order, status: "Cancelled", updatedAtBlock: currentBlock });
          cascadedGeneratorIds.push(order.conditionalOrderGenerator_id);
        } else if (order.validTo != null && order.validTo <= currentTimestamp) {
          // Expire orders past validTo (same bucket).
          context.DiscreteOrder.set({ ...order, status: "Expired", updatedAtBlock: currentBlock });
          cascadedGeneratorIds.push(order.conditionalOrderGenerator_id);
        }
      }
      await bumpGeneratorsUpdatedAt(context, cascadedGeneratorIds, currentBlock);
    },
  );
}
