/**
 * FlashLoanScanRetrier — retries Aave settlement receipt scans that failed on
 * transport errors (recorded as PendingSettlementScan by the GPv2Settlement
 * handler). No upstream equivalent: upstream drops such settlements silently.
 *
 * Runs on the same per-chain stride as the other pollers, bounded per firing,
 * and — unlike the "latest"-gated handlers — also runs during historical sync
 * (receipts are immutable; there is no reason to wait for the tip).
 */

import { indexer } from "envio";
import { scanAaveSettlement, type AaveSettlementCandidate } from "../effects/rpc.js";
import { persistAaveCandidates } from "../helpers/aaveSettlement.js";
import { log } from "../helpers/logger.js";
import { blockHandlerInterval, isTest, pollerBlockFilter, resolveCap } from "../helpers/blockHandlerShared.js";

const DEFAULT_MAX_SCAN_RETRIES_PER_BLOCK = 10;
const MAX_SCAN_ATTEMPTS = 50; // ~worst case: transient outages spanning hours

if (!isTest) {
  indexer.onBlock(
    {
      name: "FlashLoanScanRetrier",
      where: ({ chain }) => pollerBlockFilter(chain.id),
    },
    async ({ block, context }) => {
      const chainId = context.chain.id;
      const cap = resolveCap(
        `MAX_SCAN_RETRIES_PER_BLOCK_${chainId}`,
        DEFAULT_MAX_SCAN_RETRIES_PER_BLOCK,
      );

      const pending = await context.PendingSettlementScan.getWhere({
        chainId: { _eq: chainId },
        attempts: { _lt: MAX_SCAN_ATTEMPTS },
      });
      if (pending.length === 0) return;

      // Oldest settlements first.
      const batch = pending
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .sort((a: any, b: any) => Number(a.blockNumber - b.blockNumber))
        .slice(0, cap);

      let recovered = 0;
      for (const scan of batch) {
        let candidates: AaveSettlementCandidate[];
        try {
          const candidatesJson = await context.effect(scanAaveSettlement, {
            chainId,
            txHash: scan.txHash,
            blockNumber: Number(scan.blockNumber),
          });
          candidates = JSON.parse(candidatesJson) as AaveSettlementCandidate[];
        } catch {
          context.PendingSettlementScan.set({ ...scan, attempts: scan.attempts + 1 });
          continue;
        }

        await persistAaveCandidates(
          context, chainId, scan.txHash, scan.blockNumber, scan.blockTimestamp, candidates,
        );
        context.PendingSettlementScan.deleteUnsafe(scan.id);
        recovered++;
      }

      if (recovered > 0 && !context.isPreload) {
        log("info", "FlashLoanScanRetrier:DONE", { block: String(block.number), chainId, pending: pending.length, recovered });
      }
    },
  );
}
