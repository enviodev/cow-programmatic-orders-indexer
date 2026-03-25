import { GPv2Settlement } from "generated";
import { fetchOrderBookOrders } from "../effects/orderbook.js";
import { checkAaveAdapter } from "../effects/rpc.js";
import {
  conditionalOrderOwners,
  resolvedOwners,
  checkedNonAdapters,
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

  // ─── Resolve proxy/adapter owner (cache-gated) ──────────────────
  // Only check for Aave adapters if this owner created a conditional order.
  // This avoids RPC calls for 99%+ of trades that aren't programmatic.
  let realOwner: string | undefined = undefined;

  if (resolvedOwners.has(ownerKey)) {
    // Already resolved (COWShed proxy or previously detected Aave adapter)
    realOwner = resolvedOwners.get(ownerKey);
  } else if (conditionalOrderOwners.has(ownerKey) && !checkedNonAdapters.has(ownerKey)) {
    // Owner has conditional orders but isn't resolved yet — try Aave adapter detection
    const result = await context.effect(checkAaveAdapter, {
      address: owner,
      chainId,
    });

    if (result) {
      const parsed = JSON.parse(result) as { owner: string };
      realOwner = parsed.owner;
      resolvedOwners.set(ownerKey, realOwner);

      // Persist the mapping
      context.OwnerMapping.set({
        id: `${owner}-${chainId}`,
        address: owner,
        owner: realOwner,
        chainId,
        addressType: "FlashLoanHelper",
        resolutionDepth: 1, // one hop via owner()
        blockNumber: event.block.number,
        transactionHash: txHash,
      });

      // Retroactively update ConditionalOrders owned by this adapter
      const existingOrders = await context.ConditionalOrder.getWhere({
        owner: { _eq: owner },
      });
      for (const order of existingOrders) {
        context.ConditionalOrder.set({
          ...order,
          realOwner,
        });
      }

      if (!context.isPreload) {
        context.log.info(
          `Aave adapter detected: ${owner} → EOA ${realOwner} (chain=${chainId})`,
        );
      }
    } else {
      // Not an adapter — cache to avoid future RPC calls
      checkedNonAdapters.add(ownerKey);
    }
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
            validTo: BigInt(Number(apiOrder.validTo ?? 0)),
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
