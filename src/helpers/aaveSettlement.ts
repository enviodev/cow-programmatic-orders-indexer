/**
 * Shared Aave-settlement persistence — writes the scan effect's confirmed
 * candidates (FlashLoanOrder + OwnerMapping + Transaction). Used by the
 * GPv2Settlement event handler and the FlashLoanScanRetrier block handler.
 */

import { type AaveSettlementCandidate } from "../effects/rpc.js";
import { log } from "./logger.js";

export async function persistAaveCandidates(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  txHash: string,
  blockNumber: bigint,
  blockTimestamp: bigint,
  candidates: AaveSettlementCandidate[],
): Promise<void> {
  if (candidates.length === 0) return;

  context.Transaction.set({
    id: `${chainId}_${txHash}`,
    hash: txHash,
    chainId,
    blockNumber,
    blockTimestamp,
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
        blockNumber,
        blockTimestamp,
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
          blockNumber,
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
        block: String(blockNumber),
      });
    }
  }
}
