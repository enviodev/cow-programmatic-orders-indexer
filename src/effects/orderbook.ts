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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
 * `fetchWithTimeout` plus bounded retry/backoff for transient orderbook errors.
 * On 429 it honors `Retry-After` (capped); on 5xx it uses exponential backoff.
 * Throws OrderbookUnavailableError once retries/budget are exhausted.
 */
async function fetchOrderbook(
  url: string,
  init: RequestInit | undefined,
  endpoint: string,
): Promise<Response> {
  let spent = 0;
  for (let attempt = 0; ; attempt++) {
    const response = await fetchWithTimeout(url, init, ORDERBOOK_HTTP_TIMEOUT_MS, endpoint);
    if (response.ok) return response;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= ORDERBOOK_MAX_RETRIES) {
      throw new OrderbookUnavailableError(response.status, endpoint);
    }

    const retryAfterMs =
      response.status === 429 ? parseRetryAfter(response.headers.get("retry-after")) : null;
    const backoffMs = ORDERBOOK_RETRY_BASE_MS * 2 ** attempt;
    const delay = Math.min(retryAfterMs ?? backoffMs, ORDERBOOK_RETRY_MAX_DELAY_MS);

    // Fail fast rather than linger past our budget.
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

/** Batch-fetch orders by UID (chunks of BATCH_SIZE fired in parallel). */
export async function fetchOrdersByUidsRaw(
  apiBaseUrl: string,
  uids: string[],
): Promise<OrderbookOrder[]> {
  if (uids.length === 0) return [];

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
        return raw.flatMap((item) => (item?.order != null ? [item.order] : []));
      } catch (err) {
        if (err instanceof OrderbookUnavailableError) {
          log("error", "ob:unavailable", { endpoint: "ob:byUids", status: err.status, uids: chunk.length, offset: idx * BATCH_SIZE });
          return [] as OrderbookOrder[];
        }
        if (err instanceof TimeoutError) {
          log("warn", "ob:batchFetchTimeout", { uids: chunk.length, offset: idx * BATCH_SIZE, after: ORDERBOOK_HTTP_TIMEOUT_MS });
          return [] as OrderbookOrder[];
        }
        log("warn", "ob:batchFetchFailed", { err: String(err), offset: idx * BATCH_SIZE });
        return [] as OrderbookOrder[];
      }
    }),
  );

  return chunkResults.flat();
}

// ─── Effects ─────────────────────────────────────────────────────────────────

export const orderbookAccountOrders = createEffect(
  {
    name: "orderbookAccountOrders",
    input: S.schema({
      chainId: S.number,
      owner: S.string,
      maxPages: S.number, // 0 = unlimited
      signingScheme: S.optional(S.string),
      pageSize: S.number,
      since: S.optional(S.number), // Unix seconds cursor — incremental delta drain
      offset: S.optional(S.number), // resume offset — bounded full-history drain
    }),
    output: S.string, // JSON { orders: OrderbookOrder[], complete: boolean, nextOffset: number }
    cache: false, // statuses change over time
    // Generous: upstream has no client-side limit — the ported 429/Retry-After
    // backoff in fetchOrderbook is the real throttle. A tight limit here just
    // serializes the backfill (measured 341s of 700s uptime in this effect).
    rateLimit: { calls: 20, per: "second" as const },
  },
  async ({ input }): Promise<string> => {
    const apiBaseUrl = ORDERBOOK_API_URLS[input.chainId];
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
      chainId: S.number,
      owner: S.string,
      maxPages: S.number,
      pageSize: S.number,
      offset: S.number,
    }),
    output: S.string, // JSON { rows: HistoryPageRow[], complete: boolean, nextOffset: number }
    cache: true,
    rateLimit: { calls: 20, per: "second" as const },
  },
  async ({ input }): Promise<string> => {
    const apiBaseUrl = ORDERBOOK_API_URLS[input.chainId];
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
      });
    }

    return JSON.stringify({ rows, complete: result.complete, nextOffset: result.nextOffset });
  },
);

export const orderbookOrdersByUids = createEffect(
  {
    name: "orderbookOrdersByUids",
    input: S.schema({ chainId: S.number, uidsJson: S.string }),
    output: S.string, // JSON OrderbookOrder[]
    cache: false, // statuses change over time; terminal results are cached in OrderUidCache
    // Generous: see orderbookAccountOrders — 429 backoff is the real throttle.
    // (10/s previously cost 72s of rate-limit queue wait in a 700s backfill.)
    rateLimit: { calls: 50, per: "second" as const },
  },
  async ({ input }): Promise<string> => {
    const apiBaseUrl = ORDERBOOK_API_URLS[input.chainId];
    if (!apiBaseUrl) return "[]";
    const uids = JSON.parse(input.uidsJson) as string[];
    const orders = await fetchOrdersByUidsRaw(apiBaseUrl, uids);
    return JSON.stringify(orders);
  },
);
