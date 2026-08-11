/**
 * Shared plumbing for block handlers — per-chain intervals, activation floors,
 * and env-var caps.
 *
 * Upstream tunes block-handler intervals per chain in ponder.config.ts as
 * `blockTime < 8 ? 10 : 4`; here the same rule feeds indexer.onBlock `_every`
 * strides. Upstream's `startBlock: "latest"` maps to the activation floor
 * below plus a chain.isRealtime gate in the handler body.
 */

import { ACTIVE_CHAINS } from "../chains/index.js";
import { hypersyncHeight } from "./hypersync.js";
import { log } from "./logger.js";

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
 * Poller activation floor — the envio equivalent of upstream's
 * `startBlock: "latest"` block handlers.
 *
 * Every onBlock handler here is a realtime poller that no-ops during
 * historical sync, but a bare `_every` stride still fires it for EVERY
 * matching historical block: ~23M no-op invocations per full backfill
 * (hours of pure scheduling overhead — measured as "Loaders 76%" with the
 * event counter dominated by block firings). Registering with
 * `_gte: head - margin` skips them at the source.
 *
 * Resolved once at module load (top-level await) from the HyperSync head,
 * minus a margin so pollers wake just before the realtime transition. Env
 * override: POLLER_ACTIVATION_BLOCK_<chainId>. Falls back to 0 (fire
 * everywhere — previous behaviour) if the height lookup fails.
 */
const ACTIVATION_MARGIN_BLOCKS = 1_000;

async function resolveActivationFloors(): Promise<Record<number, number>> {
  const floors: Record<number, number> = {};
  await Promise.all(
    ACTIVE_CHAINS.map(async (chain) => {
      const override = Number(process.env[`POLLER_ACTIVATION_BLOCK_${chain.chainId}`]);
      if (Number.isFinite(override) && override >= 0) {
        floors[chain.chainId] = override;
        return;
      }
      // Opt-in (POLLER_FLOOR_FROM_HEAD=1): anchor pollers just below the
      // HyperSync head to skip their historical no-op firings entirely.
      // Default 0 = pollers fire through history (they no-op behind the
      // isRealtime gate); envio chews these at tens of thousands/sec and the
      // precompute deferral keeps batches from blocking on the orderbook, so
      // the default favours the simpler, well-trodden path.
      if (process.env.POLLER_FLOOR_FROM_HEAD !== "1") {
        floors[chain.chainId] = 0;
        return;
      }
      try {
        const height = await hypersyncHeight(chain.chainId);
        floors[chain.chainId] = Math.max(0, height - ACTIVATION_MARGIN_BLOCKS);
      } catch (err) {
        log("warn", "pollerActivationFloor:height_failed", { err: String(err) });
        floors[chain.chainId] = 0;
      }
    }),
  );
  return floors;
}

const POLLER_ACTIVATION_FLOOR: Record<number, number> = isTest
  ? {}
  : await resolveActivationFloors();

/** _gte floor for poller onBlock registrations (0 in tests / on lookup failure). */
export function pollerActivationFloor(chainId: number): number {
  return POLLER_ACTIVATION_FLOOR[chainId] ?? 0;
}

/** onBlock `where` filter for realtime pollers: per-chain stride, plus the
 *  activation floor when one is configured. `_gte` must be omitted when there
 *  is no floor — envio rejects a _gte below the chain start block. */
export function pollerBlockFilter(chainId: number): {
  block: { number: { _gte?: number; _every: number } };
} {
  const floor = pollerActivationFloor(chainId);
  const every = blockHandlerInterval(chainId);
  return floor > 0
    ? { block: { number: { _gte: floor, _every: every } } }
    : { block: { number: { _every: every } } };
}

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
    blockNumber: block.number,
  });
  return ts == null ? BigInt(Math.floor(Date.now() / 1000)) : BigInt(ts);
}

/**
 * Bounded-scan bucket iterator. envio's getWhere has no LIMIT, so an
 * unbounded predicate ("all pending rows") re-reads entire tables every
 * firing — measured in the tens of thousands of rows during tip drains,
 * enough to OOM a resource-capped hosted Postgres/indexer. Hex-keyed fields
 * (orderUid, params hash) are uniformly distributed, so range-bucketing the
 * first nibble caps each firing's read at ~1/16 of the table with full
 * coverage every 16 firings.
 */
const bucketCounters = new Map<string, number>();

export function nextHexBucket(key: string): { _gte: string; _lt: string } {
  const n = (bucketCounters.get(key) ?? 0) % 16;
  bucketCounters.set(key, n + 1);
  const lo = "0x" + n.toString(16);
  // Lexicographic upper bound; for the final bucket "0y" > any "0xf…".
  const hi = n === 15 ? "0y" : "0x" + (n + 1).toString(16);
  return { _gte: lo, _lt: hi };
}
