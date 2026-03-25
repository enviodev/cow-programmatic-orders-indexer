import { GPv2Settlement } from "generated";
import { fetchOrderBookOrders } from "../effects/orderbook.js";
import {
  conditionalOrderOwners,
  cowShedProxies,
} from "../utils/owner-cache.js";

// Track owners we've already fetched OrderBook orders for in this session
const fetchedOwners = new Set<string>();

GPv2Settlement.Trade.handler(async ({ event, context }) => {
  const owner = event.params.owner.toLowerCase();
  const chainId = event.chainId;
  const txHash = event.transaction.hash;
  const tradeId = `${txHash}-${event.logIndex}`;
  const ownerKey = `${owner}-${chainId}`;

  // ─── Link to ConditionalOrder (cache-gated) ─────────────────────
  // Only query DB if this owner was seen in a ConditionalOrderCreated event.
  // This skips the expensive getWhere for 99%+ of trades.
  let conditionalOrder_id: string | undefined = undefined;

  if (conditionalOrderOwners.has(ownerKey)) {
    conditionalOrder_id = conditionalOrderOwners.get(ownerKey);
  }

  // ─── Resolve COWShed proxy owner (cache-gated) ─────────────────
  // Only lookup if this address was seen in a COWShedBuilt event.
  let realOwner: string | undefined = undefined;

  if (cowShedProxies.has(ownerKey)) {
    realOwner = cowShedProxies.get(ownerKey);
  }
  // ─── Create Trade entity ──────────────────────────────────────────
  context.Trade.set({
    id: tradeId,
    chainId,
    owner,
    sellToken: event.params.sellToken.toLowerCase(),
    buyToken: event.params.buyToken.toLowerCase(),
    sellAmount: event.params.sellAmount,
    buyAmount: event.params.buyAmount,
    feeAmount: event.params.feeAmount,
    orderUid: event.params.orderUid,
    blockNumber: event.block.number,
    blockTimestamp: BigInt(event.block.timestamp),
    transactionHash: txHash,
    conditionalOrder_id: conditionalOrder_id,
    realOwner,
  });

  // ─── OrderBook API Integration ────────────────────────────────────
  if (conditionalOrder_id && !fetchedOwners.has(ownerKey)) {
    fetchedOwners.add(ownerKey);
    try {
      const orderBookJson = await context.effect(fetchOrderBookOrders, {
        owner,
        chainId,
      });

      const orderBookOrders = JSON.parse(orderBookJson) as Array<
        Record<string, unknown>
      >;
      if (Array.isArray(orderBookOrders)) {
        for (const apiOrder of orderBookOrders) {
          if (!apiOrder.uid) continue;

          context.OrderBookOrder.set({
            id: apiOrder.uid as string,
            orderUid: apiOrder.uid as string,
            owner: ((apiOrder.owner as string) ?? owner).toLowerCase(),
            status: (apiOrder.status as string) ?? "unknown",
            sellToken: ((apiOrder.sellToken as string) ?? "").toLowerCase(),
            buyToken: ((apiOrder.buyToken as string) ?? "").toLowerCase(),
            sellAmount: BigInt((apiOrder.sellAmount as string) ?? "0"),
            buyAmount: BigInt((apiOrder.buyAmount as string) ?? "0"),
            validTo: Number(apiOrder.validTo ?? 0),
            chainId,
            fetchedAt: BigInt(event.block.timestamp),
            conditionalOrder_id: conditionalOrder_id,
          });
        }
      }
    } catch (err) {
      context.log.warn(
        `OrderBook API fetch failed for owner=${owner} chain=${chainId}: ${err}`,
      );
    }
  }
});
