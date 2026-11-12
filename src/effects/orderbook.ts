/**
 * CoW Orderbook API effects — all orderbook HTTP goes through these so envio
 * can dedupe them during preload. Retry/backoff (429 Retry-After, 5xx
 * exponential) is ported 1:1 from the upstream ponder indexer's orderbook/http.ts.
 *
 * Effects never throw: page/chunk failures degrade to partial results exactly
 * like upstream (complete:false / missing UIDs), so callers retry naturally on
 * a later block.
 */

import { createEffect, S } from "envio";
import { COMPOSABLE_COW_HANDLER_ADDRESSES, ORDERBOOK_API_URLS } from "../data.js";
import {
  ORDERBOOK_HTTP_TIMEOUT_MS,
  ORDERBOOK_MAX_RETRIES,
  ORDERBOOK_PACE_MAX_WAIT_MS,
  ORDERBOOK_REQUESTS_PER_MINUTE,
  ORDERBOOK_RETRY_BASE_MS,
  ORDERBOOK_RETRY_BUDGET_MS,
  ORDERBOOK_RETRY_MAX_DELAY_MS,
  SIGNING_SCHEME_EIP1271,
} from "../constants.js";
import { encodeAbiParameters, keccak256 } from "viem";
import { fetchWithTimeout, TimeoutError } from "../helpers/withTimeout.js";
import { log } from "../helpers/logger.js";
import { BATCH_SIZE, PAGE_LIMIT, type OrderbookOrder } from "../helpers/orderbook/types.js";
import { decodeEip1271Signature } from "../decoders/erc1271-signature.js";
import { env } from "../helpers/env.js";
import { RequestPacer } from "../helpers/orderbook/pacer.js";

/**
 * The orderbook API refused to answer (HTTP 429 or 5xx) after bounded retries.
 * Distinct from "the API has no such order" (a UID simply absent from a 2xx body).
 */
export class OrderbookUnavailableError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
  ) {
    super(`[COW:orderbook-unavailable] ${endpoint} responded ${status}`);
    this.name = "OrderbookUnavailableError";
  }
}

/** The request pacer refused to send: the endpoint's lane is full or serving a 429 penalty. */
export class OrderbookThrottledError extends OrderbookUnavailableError {
  constructor(endpoint: string) {
    super(429, endpoint);
    this.name = "OrderbookThrottledError";
    this.message = `[COW:orderbook-throttled] ${endpoint} paced locally`;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type OrderbookEndpoint = "ob:byUids" | "ob:account";

const requestsPerMinute = Number(env("ORDERBOOK_REQUESTS_PER_MINUTE")) > 0
  ? Number(env("ORDERBOOK_REQUESTS_PER_MINUTE"))
  : ORDERBOOK_REQUESTS_PER_MINUTE;
const PACERS: Record<OrderbookEndpoint, RequestPacer> = {
  "ob:byUids": new RequestPacer(60_000 / requestsPerMinute, ORDERBOOK_PACE_MAX_WAIT_MS),
  "ob:account": new RequestPacer(120_000 / requestsPerMinute, ORDERBOOK_PACE_MAX_WAIT_MS),
};

// Refusals are routine under load, so report them as one line per minute.
let refused: Partial<Record<OrderbookEndpoint, number>> = {};
let refusedReportedAt = 0;
function noteRefused(endpoint: OrderbookEndpoint): void {
  refused[endpoint] = (refused[endpoint] ?? 0) + 1;
  const now = Date.now();
  if (now - refusedReportedAt < 60_000) return;
  log("warn", "ob:paced", { refused, requestsPerMinute });
  refused = {};
  refusedReportedAt = now;
}

/**
 * Global concurrency cap for orderbook HTTP. Envio's effect rateLimit only
 * shapes ADMISSION (calls/second) — in-flight concurrency is unbounded, so a
 * latency spike snowballs (measured: 500 concurrent POSTs, 18s/call, queue
 * of 8k+). A shared semaphore across every orderbook effect keeps the API
 * healthy: ~24 in flight sustains full throughput at normal ~100ms latency
 * without ever stampeding it.
 */
const MAX_ORDERBOOK_CONCURRENCY = Number(env("ORDERBOOK_CONCURRENCY")) > 0
  ? Number(env("ORDERBOOK_CONCURRENCY"))
  : 6;
let httpSlotsFree = MAX_ORDERBOOK_CONCURRENCY;
const httpSlotWaiters: Array<() => void> = [];

async function acquireHttpSlot(): Promise<void> {
  if (httpSlotsFree > 0) {
    httpSlotsFree--;
    return;
  }
  await new Promise<void>((resolve) => httpSlotWaiters.push(resolve));
}

function releaseHttpSlot(): void {
  const next = httpSlotWaiters.shift();
  if (next) next();
  else httpSlotsFree++;
}

/** Parse an orderbook order's ISO creationDate into Unix seconds. */
function orderCreationSeconds(order: OrderbookOrder): number {
  return Math.floor(new Date(order.creationDate).getTime() / 1000);
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds; null if absent/unparseable. */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * `fetchWithTimeout` plus pacing and bounded retry/backoff, as upstream.
 * On 429 the endpoint's pacer holds every request for the full Retry-After;
 * this request fails at once if that is longer than it may wait. On 5xx it
 * backs off exponentially. Throws OrderbookThrottledError when the pacer
 * refuses, OrderbookUnavailableError once retries or budget run out.
 */
async function fetchOrderbook(
  url: string,
  init: RequestInit | undefined,
  endpoint: OrderbookEndpoint,
): Promise<Response> {
  const pacer = PACERS[endpoint];
  let spent = 0;
  for (let attempt = 0; ; attempt++) {
    const wait = pacer.reserve();
    if (wait === null) {
      noteRefused(endpoint);
      throw new OrderbookThrottledError(endpoint);
    }
    if (wait > 0) await sleep(wait);

    await acquireHttpSlot();
    let response: Response;
    try {
      response = await fetchWithTimeout(url, init, ORDERBOOK_HTTP_TIMEOUT_MS, endpoint);
    } finally {
      releaseHttpSlot();
    }
    if (response.ok) return response;

    const retryable = response.status === 429 || response.status >= 500;
    const retryAfterMs =
      response.status === 429 ? parseRetryAfter(response.headers.get("retry-after")) : null;
    const backoffMs = ORDERBOOK_RETRY_BASE_MS * 2 ** attempt;
    if (response.status === 429) pacer.block(retryAfterMs ?? backoffMs);

    if (!retryable || attempt >= ORDERBOOK_MAX_RETRIES) {
      throw new OrderbookUnavailableError(response.status, endpoint);
    }
    // A penalty longer than we may wait: fail now, the next poll retries.
    if (retryAfterMs !== null && retryAfterMs > ORDERBOOK_PACE_MAX_WAIT_MS) {
      throw new OrderbookUnavailableError(response.status, endpoint);
    }

    const delay = Math.min(retryAfterMs ?? backoffMs, ORDERBOOK_RETRY_MAX_DELAY_MS);
    // Fail fast rather than hold the batch past our budget.
    if (spent + delay > ORDERBOOK_RETRY_BUDGET_MS) {
      throw new OrderbookUnavailableError(response.status, endpoint);
    }

    log("warn", "ob:retry", { endpoint, status: response.status, attempt: attempt + 1, delayMs: delay, retryAfterMs });
    await sleep(delay);
    spent += delay;
  }
}

// ─── Raw implementations (shared by the effects) ─────────────────────────────

/** Fetch orders for an owner with pagination. See upstream fetchAccountOrders.
 *  startOffset resumes a bounded drain from a prior firing; nextOffset in the
 *  result is where the next call should resume when complete=false. */
export async function fetchAccountOrdersRaw(
  apiBaseUrl: string,
  owner: string,
  maxPages = 0,
  signingScheme?: string,
  pageSize = PAGE_LIMIT,
  sinceCreationDate?: number,
  startOffset = 0,
): Promise<{ orders: OrderbookOrder[]; complete: boolean; nextOffset: number }> {
  const allOrders: OrderbookOrder[] = [];
  let offset = startOffset;
  let pagesFetched = 0;
  // complete=false means pagination was cut short by an error (rate limit / timeout /
  // network) — the caller must NOT treat the result as the owner's full history.
  let complete = false;

  while (true) {
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
    if (signingScheme) params.set("signingScheme", signingScheme);
    const url = `${apiBaseUrl}/api/v1/account/${owner}/orders?${params.toString()}`;
    try {
      const response = await fetchOrderbook(url, undefined, "ob:account");
      const page = (await response.json()) as OrderbookOrder[];

      if (sinceCreationDate !== undefined) {
        // DESC order → orders at/after the cursor form a prefix of the page.
        const fresh = page.filter((o) => orderCreationSeconds(o) >= sinceCreationDate);
        allOrders.push(...fresh);
        if (fresh.length < page.length) { complete = true; break; } // crossed the cursor — older orders already cached
      } else {
        allOrders.push(...page);
      }

      pagesFetched++;
      if (page.length < pageSize) { offset += page.length; complete = true; break; } // last page
      offset += page.length;
      // Page cap reached with a full page: more history may remain. `complete`
      // stays false so bounded drains resume from nextOffset next firing.
      if (maxPages > 0 && pagesFetched >= maxPages) break;
    } catch (err) {
      if (err instanceof OrderbookThrottledError) break; // counted in ob:paced
      if (err instanceof OrderbookUnavailableError) {
        log("error", "ob:unavailable", { endpoint: "ob:account", status: err.status, owner });
        break;
      }
      if (err instanceof TimeoutError) {
        log("warn", "ob:accountTimeout", { owner, offset, after: ORDERBOOK_HTTP_TIMEOUT_MS });
        break;
      }
      log("warn", "ob:accountFetchFailed", { owner, err: String(err) });
      break;
    }
  }

  return { orders: allOrders, complete, nextOffset: offset };
}

/** Orders found by UID, plus the UIDs whose request failed or was refused.
 *  A UID in neither list was asked and is not on the API. */
export interface OrdersByUidsResult {
  orders: OrderbookOrder[];
  unanswered: string[];
}

/** Batch-fetch orders by UID (chunks of BATCH_SIZE fired in parallel). */
export async function fetchOrdersByUidsRaw(
  apiBaseUrl: string,
  uids: string[],
  // Log tag: which chain and handler asked (upstream 6411e9a).
  source?: { chainId: number; handler: string },
): Promise<OrdersByUidsResult> {
  if (uids.length === 0) return { orders: [], unanswered: [] };

  const url = `${apiBaseUrl}/api/v1/orders/by_uids`;
  const chunks: string[][] = [];
  for (let i = 0; i < uids.length; i += BATCH_SIZE) {
    chunks.push(uids.slice(i, i + BATCH_SIZE));
  }

  const chunkResults = await Promise.all(
    chunks.map(async (chunk, idx) => {
      try {
        const response = await fetchOrderbook(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(chunk),
          },
          "ob:byUids",
        );
        const raw = (await response.json()) as { order: OrderbookOrder }[];
        return { orders: raw.flatMap((item) => (item?.order != null ? [item.order] : [])), unanswered: [] };
      } catch (err) {
        const failed: OrdersByUidsResult = { orders: [], unanswered: chunk };
        if (err instanceof OrderbookThrottledError) return failed; // counted in ob:paced
        if (err instanceof OrderbookUnavailableError) {
          log("error", "ob:unavailable", { endpoint: "ob:byUids", status: err.status, uids: chunk.length, offset: idx * BATCH_SIZE, ...source });
        } else if (err instanceof TimeoutError) {
          log("warn", "ob:batchFetchTimeout", { uids: chunk.length, offset: idx * BATCH_SIZE, after: ORDERBOOK_HTTP_TIMEOUT_MS, ...source });
        } else {
          log("warn", "ob:batchFetchFailed", { err: String(err), offset: idx * BATCH_SIZE, ...source });
        }
        return failed;
      }
    }),
  );

  return {
    orders: chunkResults.flatMap((r) => r.orders),
    unanswered: chunkResults.flatMap((r) => r.unanswered),
  };
}

// ─── Effects ─────────────────────────────────────────────────────────────────

export const orderbookAccountOrders = createEffect(
  {
    name: "orderbookAccountOrders",
    input: S.schema({
      owner: S.string,
      maxPages: S.number, // 0 = unlimited
      signingScheme: S.optional(S.string),
      pageSize: S.number,
      since: S.optional(S.number), // Unix seconds cursor — incremental delta drain
      offset: S.optional(S.number), // resume offset — bounded full-history drain
    }),
    output: S.string, // JSON { orders: OrderbookOrder[], complete: boolean, nextOffset: number }
    cache: false, // statuses change over time
    // Loose on purpose: the request pacer enforces api.cow.fi's limit across
    // chains. A tight effect limit queues calls, and a block handler waiting
    // in that queue holds the batch for every chain.
    rateLimit: { calls: 20, per: "second" as const },
  },
  async ({ input, context }): Promise<string> => {
    const apiBaseUrl = ORDERBOOK_API_URLS[context.chain.id];
    if (!apiBaseUrl) return JSON.stringify({ orders: [], complete: false, nextOffset: input.offset ?? 0 });
    const result = await fetchAccountOrdersRaw(
      apiBaseUrl,
      input.owner,
      input.maxPages,
      input.signingScheme,
      input.pageSize,
      input.since,
      input.offset ?? 0,
    );
    return JSON.stringify(result);
  },
);

/** Slim, pre-decoded composable-order row cached by orderbookAccountHistoryPage.
 *  Raw orders carry multi-KB signature blobs; envio holds effect-cache entries
 *  in memory, so the raw pages must never be cached (a 3-page window is ~10MB —
 *  caching them OOM'd the indexer). Decoding here keeps entries ~200 bytes/row. */
export interface HistoryPageRow {
  uid: string;
  paramHash: string; // keccak256(abi.encode(handler, salt, staticInput)) from the EIP-1271 signature
  status: string;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  validTo: number;
  creationDate: number; // Unix seconds
  executedSellAmount: string | null;
  executedBuyAmount: string | null;
  executedFee: string | null;
}

/**
 * Cached history-page fetch for the bounded full-history drain (phase A of
 * fetchComposableOrders). Distinct from orderbookAccountOrders: no `since`
 * cursor, cache:true — a (owner, offset) page of DESC-sorted history is stable
 * enough to cache because staleness self-heals downstream:
 *   - statuses frozen at fetch time: non-terminal rows are re-checked via
 *     by_uids (reconcileOpenCachedRows) and OrderStatusTracker
 *   - new orders shifting the pagination: after a cache-replayed drain
 *     completes, fetchComposableOrders always runs a fresh cursor-delta pass
 * This makes repeat backfills (envio dev -r) nearly free on the orderbook.
 *
 * The EIP-1271 decode + param-hash computation (pure) runs in here so only
 * slim rows are cached; generator matching (DB) stays in the caller.
 */
export const orderbookAccountHistoryPage = createEffect(
  {
    name: "orderbookAccountHistoryPage",
    input: S.schema({
      owner: S.string,
      maxPages: S.number,
      pageSize: S.number,
      offset: S.number,
    }),
    output: S.string, // JSON { rows: HistoryPageRow[], complete: boolean, nextOffset: number }
    cache: true,
    rateLimit: { calls: 20, per: "second" as const },
  },
  async ({ input, context }): Promise<string> => {
    const apiBaseUrl = ORDERBOOK_API_URLS[context.chain.id];
    if (!apiBaseUrl) return JSON.stringify({ rows: [], complete: false, nextOffset: input.offset });
    const result = await fetchAccountOrdersRaw(
      apiBaseUrl,
      input.owner,
      input.maxPages,
      SIGNING_SCHEME_EIP1271,
      input.pageSize,
      undefined,
      input.offset,
    );

    const rows: HistoryPageRow[] = [];
    for (const order of result.orders) {
      if (order.signingScheme !== SIGNING_SCHEME_EIP1271) continue;
      if (order.status === "presignaturePending") continue;
      const decoded = decodeEip1271Signature(order.signature as `0x${string}`);
      if (!decoded) continue;
      if (!COMPOSABLE_COW_HANDLER_ADDRESSES.has(decoded.handler)) continue;
      const paramHash = keccak256(
        encodeAbiParameters(
          [
            {
              type: "tuple",
              components: [
                { name: "handler", type: "address" },
                { name: "salt", type: "bytes32" },
                { name: "staticInput", type: "bytes" },
              ],
            },
          ],
          [{ handler: decoded.handler, salt: decoded.salt, staticInput: decoded.staticInput }],
        ),
      );
      rows.push({
        uid: order.uid,
        paramHash,
        status: order.status,
        sellAmount: order.sellAmount,
        buyAmount: order.buyAmount,
        feeAmount: order.feeAmount,
        validTo: order.validTo,
        creationDate: Math.floor(new Date(order.creationDate).getTime() / 1000),
        executedSellAmount: order.executedSellAmount ?? null,
        executedBuyAmount: order.executedBuyAmount ?? null,
        executedFee: order.executedFee ?? null,
      });
    }

    return JSON.stringify({ rows, complete: result.complete, nextOffset: result.nextOffset });
  },
);

export const orderbookOrdersByUids = createEffect(
  {
    name: "orderbookOrdersByUids",
    // handler is a log tag only. It is constant per call site, so preload/main
    // dedupe still works, and cache:false means no cached entries to invalidate.
    input: S.schema({ uidsJson: S.string, handler: S.string }),
    output: S.string, // JSON OrdersByUidsResult
    cache: false, // statuses change over time; terminal results are cached in OrderUidCache
    // Loose on purpose: the request pacer enforces api.cow.fi's limit
    // (~100 requests/min per IP) across chains. See orderbookAccountOrders.
    rateLimit: { calls: 20, per: "second" as const },
  },
  async ({ input, context }): Promise<string> => {
    const apiBaseUrl = ORDERBOOK_API_URLS[context.chain.id];
    const uids = JSON.parse(input.uidsJson) as string[];
    if (!apiBaseUrl) return JSON.stringify({ orders: [], unanswered: uids });
    const result = await fetchOrdersByUidsRaw(apiBaseUrl, uids, { chainId: context.chain.id, handler: input.handler });
    return JSON.stringify(result);
  },
);
