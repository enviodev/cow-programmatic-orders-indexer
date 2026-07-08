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
        log("warn", "pollerActivationFloor:height_failed", { chainId: chain.chainId, err: String(err) });
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
