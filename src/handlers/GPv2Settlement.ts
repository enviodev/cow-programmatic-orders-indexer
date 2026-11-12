/**
 * GPv2Settlement:Settlement handler — inline Aave flash-loan adapter discovery.
 * Ported from the upstream ponder indexer's settlement.ts.
 *
 * Events are filtered to solver = the Aave V3 FlashLoanRouter (per chain), so
 * only flash-loan settlements are processed. The receipt scan (Trade logs →
 * getCode + FACTORY() + owner()) runs in the cached scanAaveSettlement effect;
 * persistAaveCandidates writes the confirmed candidates:
 *   - FlashLoanOrder row (executed-only; enriched later from the orderbook)
 *   - OwnerMapping (adapter → EOA, addressType flash_loan_helper) when owner() resolved
 *
 * Improvement over upstream: a scan that fails on transport errors (RPC
 * timeout / rate limit) is recorded as a PendingSettlementScan and retried by
 * FlashLoanScanRetrier — upstream drops the settlement silently.
 */

import { indexer } from "envio";
import { AAVE_V3_ROUTER_ADDRESSES } from "../data.js";
import { hasRpc, scanAaveSettlement, type AaveSettlementCandidate } from "../effects/rpc.js";
import { persistAaveCandidates } from "../helpers/aaveSettlement.js";
import { log } from "../helpers/logger.js";
import { env } from "../helpers/env.js";

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
    if (env("DISABLE_SETTLEMENT_FACTORY_CHECK") === "true") return;

    const chainId = event.chainId;
    const txHash = event.transaction.hash;
    const blockNumber = BigInt(event.block.number);
    const blockTimestamp = BigInt(event.block.timestamp);

    let candidates: AaveSettlementCandidate[];
    try {
      // Without RPC the scan can only fail. Fail before the effect: it is
      // rate-limited, so doomed calls would still queue for admission and
      // hold the batch open (~430 Linea settlements ≈ 45s per batch).
      if (!hasRpc(chainId)) throw new Error(`[COW:scan-unavailable] no-rpc: ENVIO_RPC_URL_${chainId} unset`);
      const candidatesJson = await context.effect(scanAaveSettlement, { txHash, blockNumber: event.block.number });
      candidates = JSON.parse(candidatesJson) as AaveSettlementCandidate[];
    } catch (err) {
      // Transport failure or no RPC — queue for FlashLoanScanRetrier instead of
      // losing the settlement (upstream's behaviour) or caching the failure.
      context.PendingSettlementScan.set({
        id: txHash,
        txHash,
        blockNumber,
        blockTimestamp,
        attempts: 0,
      });
      if (!context.isPreload) {
        log("warn", "SettlementResolver:scan_deferred", { chainId, txHash, err: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    await persistAaveCandidates(context, txHash, blockNumber, blockTimestamp, candidates);
  },
);
