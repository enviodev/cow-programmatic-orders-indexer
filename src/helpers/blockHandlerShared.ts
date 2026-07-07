/**
 * Shared plumbing for block handlers — per-chain intervals and env-var caps.
 *
 * Upstream tunes block-handler intervals per chain in ponder.config.ts as
 * `blockTime < 8 ? 10 : 4`; here the same rule feeds indexer.onBlock `_every`
 * strides. All "latest"-start upstream handlers gate on chain realtime in the
 * handler body instead (envio has no per-handler startBlock:"latest").
 */

import { ACTIVE_CHAINS } from "../chains/index.js";

/** Per-chain block-handler interval: blockTime < 8 ? 10 : 4 (upstream rule). */
export function blockHandlerInterval(chainId: number): number {
  const chain = ACTIVE_CHAINS.find((c) => c.chainId === chainId);
  if (!chain) return 10;
  return chain.blockTime < 8 ? 10 : 4;
}

/** Resolve an integer cap from an env var with a default. */
export function resolveCap(envVar: string, fallback: number): number {
  const raw = Number(process.env[envVar]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Skip block-handler registration in the test environment — they interfere
 *  with integration tests that process pinned block ranges. */
export const isTest = typeof process !== "undefined" && !!process.env.VITEST;

/**
 * Read the block timestamp in an onBlock handler. Selected via
 * `field_selection.block_fields: [timestamp]` in config.yaml; the static
 * onBlock arg type only declares `number`, hence the cast.
 */
export function blockTimestamp(block: { number: number }): bigint {
  const ts = (block as { number: number; timestamp?: number }).timestamp;
  if (ts === undefined) {
    throw new Error(
      "block.timestamp missing — ensure field_selection.block_fields includes 'timestamp' in config.yaml",
    );
  }
  return BigInt(ts);
}
