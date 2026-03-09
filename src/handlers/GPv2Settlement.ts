import { GPv2Settlement } from "generated";
import { fetchOrderBookOrders } from "../effects/orderbook.js";

// Track owners we've already fetched OrderBook orders for in this session
// to avoid re-creating the same OrderBookOrder entities repeatedly.
const fetchedOwners = new Set<string>();

GPv2Settlement.Trade.handler(async ({ event, context }) => {
  const owner = event.params.owner.toLowerCase();
  const chainId = event.chainId;
  const txHash = event.transaction.hash;
  const tradeId = `${txHash}-${event.logIndex}`;

  // ─── Link to ConditionalOrder by owner lookup ──────────────────────
  // Instead of decoding settle() calldata (which requires fetching the
  // full transaction.input — often 5-20KB per tx), we match by owner.
  // If this owner has a ConditionalOrder, link the trade to it.
  let conditionalOrder_id: string | undefined = undefined;

  const ownerOrders = await context.ConditionalOrder.getWhere({
    owner: { _eq: owner },
  });

  if (ownerOrders.length > 0) {
    // Link to the most recent active order for this owner on this chain
    const chainOrders = ownerOrders
      .filter((o) => o.chainId === chainId)
      .sort((a, b) => b.blockNumber - a.blockNumber);

    const activeOrder = chainOrders.find((o) => o.status === "Active") ?? chainOrders[0];
    if (activeOrder) {
      conditionalOrder_id = activeOrder.id;
    }
  }

  // ─── Resolve COWShed proxy owner ──────────────────────────────────
  let realOwner: string | undefined = undefined;
  const proxy = await context.COWShedProxy.get(`${owner}-${chainId}`);
  if (proxy) {
    realOwner = proxy.eoaOwner;
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
  // Fetch this owner's orders from the CoW API (cached across re-indexes).
  // Only fetch once per owner per session to avoid redundant processing.
  if (conditionalOrder_id) {
    const ownerKey = `${owner}-${chainId}`;
    if (!fetchedOwners.has(ownerKey)) {
      fetchedOwners.add(ownerKey);
      try {
        const orderBookJson = await context.effect(fetchOrderBookOrders, {
          owner,
          chainId,
        });

        const orderBookOrders = JSON.parse(orderBookJson) as Array<Record<string, unknown>>;
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
  }
});
