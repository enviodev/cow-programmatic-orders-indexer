import { GPv2Settlement } from "generated";
import type { Hex } from "viem";
import { decodeSettleCalldata } from "../utils/settle-decoder.js";
import { fetchOrderBookOrders } from "../effects/orderbook.js";

// Track which settle() transactions we've already decoded to avoid
// re-decoding the same calldata for every Trade event in the same tx.
// Map: txHash → Map<tradeIndex, ConditionalOrderLink>
const decodedTxCache = new Map<string, ReturnType<typeof decodeSettleCalldata>>();

GPv2Settlement.Trade.handler(async ({ event, context }) => {
  const owner = event.params.owner.toLowerCase();
  const chainId = event.chainId;
  const txHash = event.transaction.hash;
  const tradeId = `${txHash}-${event.logIndex}`;

  // ─── ERC-1271 Signature Decoding ──────────────────────────────────────
  // Decode settle() calldata to link this trade to its conditional order.
  let conditionalOrder_id: string | undefined = undefined;

  const txInput = event.transaction.input;
  if (txInput && txInput.length > 10) {
    // Get or compute decoded trades for this transaction
    let decodedTrades = decodedTxCache.get(txHash);
    if (!decodedTrades) {
      decodedTrades = decodeSettleCalldata(txInput as Hex);
      decodedTxCache.set(txHash, decodedTrades);

      // Clean cache to prevent memory leak (keep last 100 txs)
      if (decodedTxCache.size > 100) {
        const firstKey = decodedTxCache.keys().next().value;
        if (firstKey) decodedTxCache.delete(firstKey);
      }
    }

    // Find the matching trade by logIndex position.
    // Trade events are emitted in order, so logIndex within the tx
    // corresponds to the trade index in the settle() call.
    // However, logIndex is global to the block, not the tx.
    // We use a heuristic: try each decoded trade and match by owner.
    for (const [_idx, link] of decodedTrades) {
      // The conditional order hash uniquely identifies the order
      const candidateId = `${link.orderHash}-${chainId}`;
      const existingOrder = await context.ConditionalOrder.get(candidateId);
      if (existingOrder && existingOrder.owner === owner) {
        conditionalOrder_id = candidateId;
        break;
      }
    }
  }

  // ─── Resolve COWShed proxy owner ──────────────────────────────────────
  let realOwner: string | undefined = undefined;
  const proxy = await context.COWShedProxy.get(`${owner}-${chainId}`);
  if (proxy) {
    realOwner = proxy.eoaOwner;
  }

  // ─── Create Trade entity ──────────────────────────────────────────────
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

  // ─── OrderBook API Integration ────────────────────────────────────────
  // Fetch this owner's orders from the CoW API (cached across re-indexes).
  // Only do this for owners that have conditional orders (programmatic).
  if (conditionalOrder_id) {
    try {
      const orderBookOrders = await context.effect(fetchOrderBookOrders, {
        owner,
        chainId,
      });

      if (Array.isArray(orderBookOrders)) {
        for (const apiOrder of orderBookOrders) {
          if (!apiOrder.uid) continue;

          context.OrderBookOrder.set({
            id: apiOrder.uid,
            orderUid: apiOrder.uid,
            owner: (apiOrder.owner ?? owner).toLowerCase(),
            status: apiOrder.status ?? "unknown",
            sellToken: (apiOrder.sellToken ?? "").toLowerCase(),
            buyToken: (apiOrder.buyToken ?? "").toLowerCase(),
            sellAmount: BigInt(apiOrder.sellAmount ?? "0"),
            buyAmount: BigInt(apiOrder.buyAmount ?? "0"),
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
