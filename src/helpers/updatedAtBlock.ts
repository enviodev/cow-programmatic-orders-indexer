/**
 * Sync-cursor bump helper — ported from the upstream ponder indexer's
 * helpers/updatedAtBlock.ts (upstream issues one bulk UPDATE; envio bumps
 * per row through the entity API).
 */

/**
 * Bump the sync cursor (updatedAtBlock) on a set of generators after their own
 * state or any of their discrete orders changed. Dedupes ids so callers can
 * pass one id per changed part.
 */
export async function bumpGeneratorsUpdatedAt(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  generatorIds: string[],
  blockNumber: bigint,
): Promise<void> {
  if (generatorIds.length === 0) return;

  for (const id of [...new Set(generatorIds)]) {
    const generator = await context.ConditionalOrderGenerator.get(id);
    if (!generator) continue;
    if (generator.updatedAtBlock === blockNumber) continue; // already bumped this block
    context.ConditionalOrderGenerator.set({ ...generator, updatedAtBlock: blockNumber });
  }
}
