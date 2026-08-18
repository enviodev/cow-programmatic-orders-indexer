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

const ZERO_TOTALS: TwapAdditionalData = {
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

/** Rebuild TWAP parents' execution totals (additionalData) after part-order writes.
 *  TWAP-only: every part sells the same token, so summing raw amounts is unit-safe
 *  (the orderbook reports executedFee in the sell token for sell orders). Other
 *  order types keep additionalData null — e.g. PerpetualSwap parts alternate
 *  direction, so a single sum would mix token units. */
export async function refreshTwapExecutedTotals(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  generatorIds: string[],
): Promise<void> {
  const ids = [...new Set(generatorIds)];
  if (ids.length === 0) return;

  for (const id of ids) {
    const generator = await context.ConditionalOrderGenerator.get(id);
    if (!generator || generator.orderType !== "TWAP") continue;

    const parts = await context.DiscreteOrder.getWhere({
      conditionalOrderGenerator_id: { _eq: id },
    });

    const totals: TwapAdditionalData = parts.length === 0
      ? ZERO_TOTALS
      : {
          executedSellAmount: sumField(parts, "executedSellAmount"),
          executedBuyAmount: sumField(parts, "executedBuyAmount"),
          executedFee: sumField(parts, "executedFee"),
        };

    context.ConditionalOrderGenerator.set({ ...generator, additionalData: totals });
  }
}
