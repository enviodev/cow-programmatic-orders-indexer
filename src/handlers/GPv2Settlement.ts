/**
 * GPv2Settlement:Settlement handler — inline Aave flash-loan adapter discovery.
 * Ported from the upstream ponder indexer's settlement.ts.
 *
 * Events are filtered to solver = the Aave V3 FlashLoanRouter (per chain), so
 * only flash-loan settlements are processed. The receipt scan (Trade logs →
 * getCode + FACTORY() + owner()) runs in the cached scanAaveSettlement effect;
 * this handler persists the confirmed candidates:
 *   - FlashLoanOrder row (executed-only; enriched later from the orderbook)
 *   - OwnerMapping (adapter → EOA, addressType flash_loan_helper) when owner() resolved
 */

import { indexer } from "envio";
import { AAVE_V3_ROUTER_ADDRESSES } from "../data.js";
import { scanAaveSettlement, type AaveSettlementCandidate } from "../effects/rpc.js";
import { log } from "../helpers/logger.js";

indexer.onEvent(
  {
    contract: "GPv2Settlement",
    event: "Settlement",
    where: ({ chain }) => {
      const router = AAVE_V3_ROUTER_ADDRESSES[chain.id];
      if (!router) return false; // no flash-loan infra on this chain
      return { params: { solver: router } };
    },
  },
  async ({ event, context }) => {
    if (process.env.DISABLE_SETTLEMENT_FACTORY_CHECK === "true") return;

    const chainId = event.chainId;
    const txHash = event.transaction.hash;

    const candidatesJson = await context.effect(scanAaveSettlement, { chainId, txHash });
    const candidates = JSON.parse(candidatesJson) as AaveSettlementCandidate[];
    if (candidates.length === 0) return;

    context.Transaction.set({
      id: `${chainId}_${txHash}`,
      hash: txHash,
      chainId,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: BigInt(event.block.timestamp),
    });

    for (const c of candidates) {
      // The order row is always created (insert-only, idempotent for replays),
      // enriched=false so FlashLoanOrderEnricher picks it up.
      const orderId = `${chainId}_${c.orderUid}`;
      const existingOrder = await context.FlashLoanOrder.get(orderId);
      if (!existingOrder) {
        context.FlashLoanOrder.set({
          id: orderId,
          orderUid: c.orderUid,
          chainId,
          adapter: c.adapter,
          sellToken: c.sellToken,
          buyToken: c.buyToken,
          executedSellAmount: c.sellAmount,
          executedBuyAmount: c.buyAmount,
          feeAmount: c.feeAmount,
          txHash,
          blockNumber: BigInt(event.block.number),
          blockTimestamp: BigInt(event.block.timestamp),
          validTo: BigInt(c.validTo),
          owner: c.owner ?? undefined,
          receiver: undefined,
          kind: undefined,
          sellAmountIntended: undefined,
          buyAmountIntended: undefined,
          source: "aave",
          type: c.type ?? undefined,
          enriched: false,
          enrichedAt: undefined,
          enrichmentAttempts: 0,
        });
      }

      // The mapping is written whenever the EOA resolved (insert-only).
      if (c.owner) {
        const mappingId = `${chainId}_${c.adapter}`;
        const existingMapping = await context.OwnerMapping.get(mappingId);
        if (!existingMapping) {
          context.OwnerMapping.set({
            id: mappingId,
            address: c.adapter,
            chainId,
            owner: c.owner,
            addressType: "flash_loan_helper",
            txHash,
            blockNumber: BigInt(event.block.number),
            resolutionDepth: 1,
          });
        }
      }

      if (!context.isPreload) {
        log("info", "SettlementResolver:aave_adapter_mapped", {
          chainId,
          adapter: c.adapter,
          eoa: c.owner,
          orderUid: c.orderUid,
          type: c.type,
          block: String(event.block.number),
        });
      }
    }
  },
);
