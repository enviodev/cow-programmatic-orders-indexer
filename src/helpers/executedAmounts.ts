/**
 * TWAP parent execution totals — ported from the upstream ponder indexer's
 * helpers/executedAmounts.ts (upstream aggregates with one SQL GROUP BY; envio
 * sums the parts' entity rows in-process).
 */

/** TWAP parent totals aggregated across its discrete orders. Decimal strings in
 *  raw token units; executedFee is in the sell token (TWAP parts are sell orders). */
export interface TwapAdditionalData {
  executedSellAmount: string;
  executedBuyAmount: string;
  executedFee: string;
}

export const ZERO_TOTALS: TwapAdditionalData = {
  executedSellAmount: "0",
  executedBuyAmount: "0",
  executedFee: "0",
};

/** Sum a decimal-string field, treating null/undefined/unparseable as 0. */
function sumField(rows: { [k: string]: unknown }[], field: string): string {
  let total = 0n;
  for (const row of rows) {
    const raw = row[field];
    if (raw == null) continue;
    try {
      total += BigInt(raw as string);
    } catch {
      // non-numeric — skip, mirroring SQL's numeric cast semantics on clean data
    }
  }
  return total.toString();
}

/** Rebuild TWAP parents' execution state after part-order writes.
 *  TWAP-only: every part sells the same token, so summing raw amounts is unit-safe
 *  (the orderbook reports executedFee in the sell token for sell orders). Other
 *  order types keep additionalData null — e.g. PerpetualSwap parts alternate
 *  direction, so a single sum would mix token units.
 *
 *  Also owns the TWAP lifecycle (upstream ac3353d): a parent whose parts are
 *  all known and none open flips to Completed; orderbook reorg reconciliation
 *  can reopen a previously terminal part, which flips it back to Active.
 *  Returns the generator ids completed by this call. */
export async function refreshTwapExecutionState(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  generatorIds: string[],
  blockNumber: bigint,
): Promise<string[]> {
  const ids = [...new Set(generatorIds)];
  const completed: string[] = [];
  for (const id of ids) {
    const generator = await context.ConditionalOrderGenerator.get(id);
    if (!generator || generator.orderType !== "TWAP") continue;

    const parts = await context.DiscreteOrder.getWhere({
      conditionalOrderGenerator_id: { _eq: id },
    });
    const candidates = await context.CandidateDiscreteOrder.getWhere({
      conditionalOrderGenerator_id: { _eq: id },
    });

    const totals: TwapAdditionalData = parts.length === 0
      ? ZERO_TOTALS
      : {
          executedSellAmount: sumField(parts, "executedSellAmount"),
          executedBuyAmount: sumField(parts, "executedBuyAmount"),
          executedFee: sumField(parts, "executedFee"),
        };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openPartCount = parts.filter((p: any) => p.status === "Open").length;
    const hasCandidates = candidates.length > 0;

    const isComplete =
      generator.status === "Active" &&
      generator.allCandidatesKnown &&
      parts.length > 0 &&
      openPartCount === 0 &&
      !hasCandidates;
    // Orderbook reorg reconciliation can reopen a previously terminal part.
    const isReopened =
      generator.status === "Completed" && (openPartCount > 0 || hasCandidates);

    context.ConditionalOrderGenerator.set({
      ...generator,
      additionalData: totals,
      ...(isComplete
        ? { status: "Completed", lastPollResult: "executionState:allTerminal", updatedAtBlock: blockNumber }
        : {}),
      ...(isReopened
        ? { status: "Active", lastPollResult: "executionState:reopened", updatedAtBlock: blockNumber }
        : {}),
    });
    if (isComplete) completed.push(id);
  }
  return completed;
}
