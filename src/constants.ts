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
 *
 * Upstream caps a single sleep at 2s / 4s total because ponder block handlers
 * hold a Postgres transaction open across the call. Envio effects hold
 * nothing, so we can honor api.cow.fi's actual Retry-After (observed: 30s
 * penalties) — retrying inside the penalty window just earns another 429.
 * The shared HTTP semaphore turns these sleeps into natural backpressure.
 */
export const ORDERBOOK_MAX_RETRIES = 5;
export const ORDERBOOK_RETRY_BASE_MS = 250; // exponential backoff base
export const ORDERBOOK_RETRY_MAX_DELAY_MS = 60_000; // cap on a single sleep (incl. Retry-After)
export const ORDERBOOK_RETRY_BUDGET_MS = 120_000; // total wall-clock the retry loop may add

/**
 * Outer wall-clock cap for a whole batched status fetch — must accommodate
 * the retry budget above (a batch honoring one 30s Retry-After is healthy,
 * not hung).
 */
export const ORDERBOOK_BATCH_TIMEOUT_MS = ORDERBOOK_RETRY_BUDGET_MS + 2 * 10_000;

/**
 * Hard wall-clock cap for a block handler's aggregate multicall
 * (OrderDiscoveryPoller, CancellationWatcher).
 */
export const BLOCK_HANDLER_RPC_TIMEOUT_MS = 15_000;

// Tighter cap for cheap inner-loop calls (getCode, eth_call) in the settlement handler.
export const SETTLEMENT_INNER_RPC_TIMEOUT_MS = 5_000;

/**
 * Wall-clock slice for one per-owner drain attempt in OwnerBackfill. The attempt's
 * cooperative deadline fires at this point; pages already fetched are persisted with
 * the resume offset (OwnerDrainProgress), so hitting the deadline is not a failure —
 * the owner just continues from where it stopped on a later firing.
 */
export const BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS = 30_000;

/**
 * Per-block ceiling on how many distinct owners OwnerBackfill drains in a single
 * firing. Owner fetches run concurrently (see DEFAULT_OWNER_BACKFILL_CONCURRENCY),
 * so the per-firing wall-clock is roughly ceil(cap / concurrency) ×
 * BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS — keep cap = concurrency so a firing stays
 * ~one slice. Override per chain with env var MAX_OWNERS_BACKFILL_PER_BLOCK_<chainId>.
 */
export const DEFAULT_MAX_OWNERS_BACKFILL_PER_BLOCK = 20;

/**
 * How many owner history fetches OwnerBackfill runs concurrently within a single
 * firing. Bounds in-flight orderbook API load while collapsing the per-firing
 * wall-clock: at concurrency >= cap, a firing takes ~one BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS
 * worst case instead of cap × that.
 *
 * Override per chain with env var MAX_OWNERS_BACKFILL_CONCURRENCY_<chainId>.
 */
export const DEFAULT_OWNER_BACKFILL_CONCURRENCY = 20;

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
