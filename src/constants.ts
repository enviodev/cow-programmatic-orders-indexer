/**
 * Application-level constants — tuning parameters with no chain dependency.
 * Chain-specific config (addresses, block times, poll intervals) lives in src/data.ts.
 *
 * Ported 1:1 from the upstream ponder indexer's src/constants.ts.
 */

/**
 * Fallback orderbook recheck cadence, in blocks. After a successful
 * getTradeableOrderWithSignature call, schedule the next check this many blocks
 * later when the chain has no entry in RECHECK_INTERVAL_BLOCKS_BY_CHAIN_ID
 * (src/data.ts).
 */
export const DEFAULT_RECHECK_INTERVAL_BLOCKS = 20n;

/**
 * The signingScheme value returned by the CoW Orderbook API for EIP-1271 signed orders.
 * Note: spelled "eip1271" in the API response — NOT "erc1271".
 */
export const SIGNING_SCHEME_EIP1271 = "eip1271";

/**
 * Hard per-block ceiling on how many generators the OrderDiscoveryPoller
 * will multicall in a single block. Generators exceeding the cap defer to the
 * next block (prioritized by oldest lastCheckBlock first).
 *
 * Override per chain with env var MAX_GENERATORS_PER_BLOCK_<chainId>.
 */
export const DEFAULT_MAX_GENERATORS_PER_BLOCK = 200;

/**
 * Progressive backoff for generators stuck returning PollResult.tryNextBlock.
 *
 * Every tryNextBlock response increments a counter on the generator; any other
 * response resets it to zero. The counter selects the next-check block offset:
 *   count <= WARMUP_THRESHOLD   -> +1 block  (default, healthy behavior)
 *   count <= COOLDOWN_THRESHOLD -> +10 blocks
 *   count >  COOLDOWN_THRESHOLD -> +50 blocks
 */
export const TRY_NEXT_BLOCK_WARMUP_THRESHOLD = 50;
export const TRY_NEXT_BLOCK_COOLDOWN_THRESHOLD = 200;
export const TRY_NEXT_BLOCK_BACKOFF_WARMUP = 1n;
export const TRY_NEXT_BLOCK_BACKOFF_MID = 10n;
export const TRY_NEXT_BLOCK_BACKOFF_COLD = 50n;

/**
 * CancellationWatcher re-check cadence, in blocks.
 *
 * For deterministic generators (`allCandidatesKnown = true`), `remove()` detection
 * is via a `ComposableCoW.singleOrders(owner, hash)` storage read. `remove()` is
 * rare; a ~100 block cadence gives a worst-case detection lag on the order of
 * minutes while keeping the RPC cost well below OrderDiscoveryPoller's poll.
 */
export const DETERMINISTIC_CANCEL_SWEEP_INTERVAL = 100n;

/**
 * Hard wall-clock cap for a single orderbook HTTP request (per page or per
 * batched `by_uids` chunk).
 */
export const ORDERBOOK_HTTP_TIMEOUT_MS = 10_000;

/**
 * Bounded retry for transient orderbook failures (HTTP 429 / 5xx).
 * The loop adds at most ORDERBOOK_RETRY_BUDGET_MS of wall-clock; if a
 * `Retry-After` (or backoff) would exceed the budget, fail fast and let the
 * next poll retry naturally.
 */
export const ORDERBOOK_MAX_RETRIES = 2; // ≤ 3 attempts total
export const ORDERBOOK_RETRY_BASE_MS = 250; // exponential backoff base
export const ORDERBOOK_RETRY_MAX_DELAY_MS = 2_000; // cap on a single sleep (incl. Retry-After)
export const ORDERBOOK_RETRY_BUDGET_MS = 4_000; // total wall-clock the retry loop may add

/**
 * Hard wall-clock cap for a block handler's aggregate multicall
 * (OrderDiscoveryPoller, CancellationWatcher).
 */
export const BLOCK_HANDLER_RPC_TIMEOUT_MS = 15_000;

// Tighter cap for cheap inner-loop calls (getCode, eth_call) in the settlement handler.
export const SETTLEMENT_INNER_RPC_TIMEOUT_MS = 5_000;

/**
 * Hard wall-clock cap for the whole per-owner bootstrap fetch in OwnerBackfill
 * (account pagination + by_uids refresh). An owner that exceeds this is left
 * eligible (historyBackfilled stays false) and retried later.
 */
export const BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS = 30_000;

/**
 * Per-block ceiling on how many distinct owners OwnerBackfill drains in a single
 * firing. Override per chain with env var MAX_OWNERS_BACKFILL_PER_BLOCK_<chainId>.
 */
export const DEFAULT_MAX_OWNERS_BACKFILL_PER_BLOCK = 100;

/**
 * Maximum number of TWAP parts that precomputeOrderUids will attempt to enumerate.
 * Pathological orders with n > this value skip precompute and fall back to the
 * OrderDiscoveryPoller discovery path (allCandidatesKnown=false).
 */
export const MAX_TWAP_PRECOMPUTE_PARTS = 100_000;

/**
 * Hard per-block ceiling on how many open discrete orders OrderStatusTracker
 * will check in a single block. Override per chain with env var
 * MAX_DISCRETE_ORDERS_PER_BLOCK_<chainId>.
 */
export const DEFAULT_MAX_DISCRETE_ORDERS_PER_BLOCK = 200;

/**
 * Per-block cap on how many pending flash-loan orders FlashLoanOrderEnricher
 * enriches from the orderbook per chain. Override per chain with env var
 * MAX_FLASH_LOAN_ORDERS_PER_BLOCK_<chainId>.
 */
export const DEFAULT_MAX_FLASH_LOAN_ORDERS_PER_BLOCK = 200;

/**
 * Max orderbook-enrichment attempts before a flash-loan order is treated as
 * permanently un-enrichable (never indexed by the orderbook / aged out) and is
 * no longer polled.
 */
export const MAX_FLASH_LOAN_ENRICHMENT_ATTEMPTS = 10;

/**
 * Slice size for the one-shot FlashLoanOrderBackfiller drain. The historical
 * backlog is processed in sequential slices of this many UIDs to bound orderbook
 * concurrency.
 */
export const FLASH_LOAN_BACKFILL_SLICE_SIZE = 500;
