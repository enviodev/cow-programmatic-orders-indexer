/**
 * OrderStatusTracker — polls the API for status updates on open discrete
 * orders. Expires past validTo. Ported from the upstream ponder indexer's
 * orderStatusTracker.ts.
 */

import { indexer } from "envio";
import { DEFAULT_MAX_DISCRETE_ORDERS_PER_BLOCK } from "../constants.js";
import { fetchOrderStatusByUids } from "../helpers/orderbook/client.js";
import { toDiscreteStatus } from "../helpers/orderbook/types.js";
import { log } from "../helpers/logger.js";
import { blockHandlerInterval, blockTimestamp, isTest, resolveCap, pollerActivationFloor } from "../helpers/blockHandlerShared.js";

const VALID_DISCRETE_STATUSES = new Set(["fulfilled", "unfilled", "expired", "cancelled"]);

if (!isTest) {
  indexer.onBlock(
    {
      name: "OrderStatusTracker",
      where: ({ chain }) => ({ block: { number: { _gte: pollerActivationFloor(chain.id), _every: blockHandlerInterval(chain.id) } } }),
    },
    async ({ block, context }) => {
      if (!context.chain.isRealtime) return; // startBlock "latest" upstream

      const chainId = context.chain.id;
      const currentTimestamp = await blockTimestamp(context, block);

      const maxOrdersPerBlock = resolveCap(
        `MAX_DISCRETE_ORDERS_PER_BLOCK_${chainId}`,
        DEFAULT_MAX_DISCRETE_ORDERS_PER_BLOCK,
      );

      const allOpen = await context.DiscreteOrder.getWhere({
        chainId: { _eq: chainId },
        status: { _eq: "Open" },
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
        const statuses = await fetchOrderStatusByUids(context, chainId, uids);

        let updated = 0;
        for (const order of openOrders) {
          const info = statuses.get(order.orderUid);
          if (!info || !VALID_DISCRETE_STATUSES.has(info.status)) continue;
          // promotedAt intentionally preserved across status updates.
          context.DiscreteOrder.set({
            ...order,
            status: toDiscreteStatus(info.status),
            executedSellAmount: info.executedSellAmount ?? undefined,
            executedBuyAmount: info.executedBuyAmount ?? undefined,
          });
          updated++;
        }

        if (updated > 0 && !context.isPreload) {
          log("info", "OrderStatusTracker:DONE", { block: String(block.number), chainId, open: openOrders.length, updated });
        }
      }

      // Parent-cancelled cascade: any open discrete order whose parent generator
      // is Cancelled and whose API state is non-terminal should be cancelled from
      // on-chain truth. The API loop above already applied API-terminal statuses,
      // so what remains status=Open here is exactly the "API silent" set.
      const cancelledGenerators = await context.ConditionalOrderGenerator.getWhere({
        chainId: { _eq: chainId },
        status: { _eq: "Cancelled" },
      });
      const cancelledGeneratorIds = new Set<string>(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cancelledGenerators.map((g: any) => g.id),
      );

      if (cancelledGeneratorIds.size > 0) {
        const stillOpen = await context.DiscreteOrder.getWhere({
          chainId: { _eq: chainId },
          status: { _eq: "Open" },
        });
        for (const order of stillOpen) {
          if (!cancelledGeneratorIds.has(order.conditionalOrderGenerator_id)) continue;
          context.DiscreteOrder.set({ ...order, status: "Cancelled" });
        }
      }

      // Expire orders past validTo
      const expirable = await context.DiscreteOrder.getWhere({
        chainId: { _eq: chainId },
        status: { _eq: "Open" },
        validTo: { _lte: currentTimestamp },
      });
      for (const order of expirable) {
        context.DiscreteOrder.set({ ...order, status: "Expired" });
      }
    },
  );
}
