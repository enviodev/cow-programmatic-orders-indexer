/**
 * Minimal HyperSync HTTP client for effect-side data queries (logs, block
 * headers). HyperSync serves historical log/header lookups far faster than
 * JSON-RPC and doesn't burn RPC quota — effects should only fall back to RPC
 * for state reads (eth_call / getCode), which HyperSync cannot answer.
 *
 * Endpoint pattern: https://{chainId}.hypersync.xyz/query with the same
 * ENVIO_API_TOKEN the indexer already uses for event ingestion.
 */

import { fetchWithTimeout } from "./withTimeout.js";

const HYPERSYNC_QUERY_TIMEOUT_MS = 20_000;

/** Concurrency cap for effect-side HyperSync queries — they share capacity
 *  with the indexer's own event stream, and unbounded concurrent /query calls
 *  produce queueing timeouts (same stampede mode as any HTTP dependency). */
const MAX_HYPERSYNC_CONCURRENCY = 10;
let slotsFree = MAX_HYPERSYNC_CONCURRENCY;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (slotsFree > 0) { slotsFree--; return; }
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) next();
  else slotsFree++;
}

export interface HypersyncLog {
  transaction_hash: string;
  data: string;
  topic0: string | null;
  topic1: string | null;
  topic2: string | null;
  topic3: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function hypersyncQuery(body: Record<string, unknown>): Promise<any> {
  await acquireSlot();
  try {
    return await hypersyncQueryInner(chainId, body);
  } finally {
    releaseSlot();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function hypersyncQueryInner(body: Record<string, unknown>): Promise<any> {
  const token = process.env.ENVIO_API_TOKEN;
  const response = await fetchWithTimeout(
    `https://${chainId}.hypersync.xyz/query`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    HYPERSYNC_QUERY_TIMEOUT_MS,
    "hypersync:query",
  );
  if (!response.ok) {
    throw new Error(`hypersync query failed: HTTP ${response.status}`);
  }
  return response.json();
}

/** All logs for (address, topic0) in a single block. */
export async function hypersyncBlockLogs(
  blockNumber: number,
  address: string,
  topic0: string,
): Promise<HypersyncLog[]> {
  const result = await hypersyncQuery(chainId, {
    from_block: blockNumber,
    to_block: blockNumber + 1,
    logs: [{ address: [address], topics: [[topic0]] }],
    field_selection: {
      log: ["transaction_hash", "data", "topic0", "topic1", "topic2", "topic3"],
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const batches = (result?.data ?? []) as Array<{ logs?: any[] }>;
  return batches.flatMap((b) => (b.logs ?? []) as HypersyncLog[]);
}

/** Block timestamp (Unix seconds) from the header, or null when unavailable. */
export async function hypersyncBlockTimestamp(
  blockNumber: number,
): Promise<number | null> {
  const result = await hypersyncQuery(chainId, {
    from_block: blockNumber,
    to_block: blockNumber + 1,
    include_all_blocks: true,
    field_selection: { block: ["number", "timestamp"] },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const batches = (result?.data ?? []) as Array<{ blocks?: any[] }>;
  for (const b of batches) {
    for (const blk of b.blocks ?? []) {
      if (blk.timestamp != null) return Number(BigInt(blk.timestamp));
    }
  }
  return null;
}

/** Current HyperSync chain height (fast, no RPC). */
export async function hypersyncHeight(chainId: number): Promise<number> {
  const token = process.env.ENVIO_API_TOKEN;
  const response = await fetchWithTimeout(
    `https://${chainId}.hypersync.xyz/height`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    HYPERSYNC_QUERY_TIMEOUT_MS,
    "hypersync:height",
  );
  if (!response.ok) throw new Error(`hypersync height failed: HTTP ${response.status}`);
  const body = (await response.json()) as { height: number };
  return Number(body.height);
}
