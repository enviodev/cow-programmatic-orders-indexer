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
 * Resolve the block timestamp in an onBlock handler. envio only passes the
 * block number to onBlock handlers, so this reads the header via the cached
 * getBlockTimestamp effect. Falls back to wall-clock when no RPC is
 * configured — acceptable because every caller runs at realtime, where the
 * head block timestamp is within seconds of now.
 */
export async function blockTimestamp(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  block: { number: number },
): Promise<bigint> {
  const { getBlockTimestamp } = await import("../effects/rpc.js");
  const ts = await context.effect(getBlockTimestamp, {
    chainId: context.chain.id,
    blockNumber: block.number,
  });
  return ts == null ? BigInt(Math.floor(Date.now() / 1000)) : BigInt(ts);
}
