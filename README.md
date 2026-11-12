# CoW Programmatic Orders Indexer (Envio)

Envio HyperIndex port of the [CoW programmatic orders ponder indexer](../cow-programmatic-orders-api)
(now maintained as [cowprotocol/cow-programmatic-orders-api](https://github.com/cowprotocol/cow-programmatic-orders-api)),
kept 1:1 with upstream's indexing behaviour. Mapped through upstream commit
`b81c994` (behavioral content through `d9d313e`) on envio 3.16.0. Indexes Composable CoW conditional-order
generators, the discrete-order lifecycle (UID precompute → candidate → orderbook-confirmed),
COWShed proxy ownership, and Aave V3 flash-loan orders on **all 11 supported chains**
(mainnet, gnosis, arbitrum, avalanche, base, bnb, ink, linea, plasma, polygon, sepolia —
upstream e3f3d63). HyperSync streams every chain without per-chain RPC contracts; the
on-chain poll effects use `ENVIO_RPC_URL_<chainId>` where configured and degrade
gracefully where not.

## What it indexes

- **ComposableCoW `ConditionalOrderCreated`** → `ConditionalOrderGenerator` with decoded
  staticInput for 11 order types. Deterministic types (TWAP, StopLoss, CirclesBackingOrder)
  get their discrete-order UIDs precomputed at creation and checked against the orderbook.
- **CoWShedFactory `COWShedBuilt`** → `OwnerMapping` (proxy → EOA).
- **GPv2Settlement `Settlement`** (filtered to the Aave V3 FlashLoanRouter solver) →
  receipt scan detects per-order Aave adapters → `FlashLoanOrder` + `OwnerMapping`.
- **Block handlers** (realtime): OrderDiscoveryPoller (getTradeableOrderWithSignature
  multicall), CandidateConfirmer, OrderStatusTracker, OwnerBackfill(+Live),
  CancellationWatcher (singleOrders sweep), FlashLoanOrderBackfiller/Enricher.

Chain registry lives in `src/chains/` (mirrors upstream `src/chains/`); addresses and
start blocks in `config.yaml` must match it.

## Run

```bash
pnpm install
pnpm codegen          # after any config.yaml / schema.graphql change
TUI_OFF=true pnpm dev # start indexing (GraphQL at http://localhost:8080, password `testing`)
pnpm tsc --noEmit     # type-check
pnpm test             # unit + integration tests (integration needs network)
```

## Environment (.env)

- `ENVIO_API_TOKEN` — HyperSync token (event indexing). https://envio.dev/app/api-tokens
- `ENVIO_RPC_URL_1`, `ENVIO_RPC_URL_100` — RPC URLs for view calls: order polling,
  cancellation sweeps, flash-loan adapter detection, block timestamps. Without them the
  pollers no-op gracefully (event indexing still works via HyperSync).
- Optional knobs. Each is read as `ENVIO_<NAME>` first (hosted envio-cloud only accepts
  ENVIO_-prefixed keys), then as the bare `<NAME>`:
  - Per-firing caps: `MAX_GENERATORS_PER_BLOCK_<chainId>`, `MAX_DISCRETE_ORDERS_PER_BLOCK_<chainId>`,
    `MAX_OWNERS_BACKFILL_PER_BLOCK_<chainId>`, `MAX_FLASH_LOAN_ORDERS_PER_BLOCK_<chainId>`,
    `MAX_PRECOMPUTES_PER_BLOCK_<chainId>`, `MAX_SCAN_RETRIES_PER_BLOCK_<chainId>`.
  - Orderbook: `ORDERBOOK_CONCURRENCY`; `ORDERBOOK_REQUESTS_PER_MINUTE` (default 80
    for `by_uids`, half that for `account`); `ORDERBOOK_API_URL_TEMPLATE`, e.g.
    `http://{network}-api-prod.services.svc.cluster.local` (`{network}` is the chain's API
    path with dashes, default `https://api.cow.fi/<path>`).
  - Pollers: `POLLER_FLOOR_FROM_HEAD=0` (fire through all history; default anchors
    pollers near the head), `POLLER_ACTIVATION_BLOCK_<chainId>` (pin the floor).
  - Escape hatches: `DISABLE_SETTLEMENT_FACTORY_CHECK=true`, `DISABLE_OWNER_BACKFILL=1`.

## CoW Orderbook API budget

api.cow.fi enforces ~100 requests/minute per IP per read endpoint (documented),
and answers bursts with 429 and a 30s Retry-After. One request pacer per endpoint,
shared by all chains, keeps under it: `by_uids` 80 requests/min (100 UIDs each),
`account` 40/min, plus a concurrency semaphore. During a 429 penalty the pacer
refuses requests instead of sleeping, and so does any request that would wait more
than 4s for a slot: block handlers await these calls, and envio commits no chain's
batch until they return. Refused UIDs are retried on a later block. For elevated
limits CoW suggests contacting bd@cow.fi.

## Deviations from upstream (by necessity)

- No API layer (Hono `/orders-by-owner`, `/readyz`) — envio serves Hasura GraphQL over the
  same tables instead.
- `DiscreteOrderStatus` enum values are capitalized (`open` is reserved in envio schemas);
  `validTo` fields are BigInt (uint32 max overflows Int32).
- Upstream's durable `cow_cache` Postgres schema is modelled as `OrderUidCache` /
  `ComposableOrderCache` entities (rebuilt on a full re-sync).
- `FlashLoanOrder.enriched` boolean mirrors `enrichedAt IS NULL` for queryability.
- Block handlers derive "startBlock: latest" semantics from `chain.isRealtime`.
- Upstream's `cow_cache.owner_drain` is the `OwnerDrainProgress` entity; the owner drain
  runs as bounded, resumable page windows (an envio handler cannot leave orphaned writes
  running past its own resolution, so progress is checkpointed per firing instead of
  relying on an AbortController-terminated fetch).
- `disable_default_cross_chain: true` (envio ≥3.6): rows are keyed `(id, chainId)`, so
  entity ids are the bare upstream keys (orderUid, owner, txHash) without a chain prefix,
  and effects are chain-scoped via `context.chain.id`.
- OrderStatusTracker's soft-terminal re-poll skips rows with a null `validTo`
  (`getWhere` has no IS NULL); such rows are rare — every write path stores `validTo`
  when the API provides one.
- Upstream's SQL views (`part_order` union of discrete+candidate rows, and
  `programmatic_order` with part counts — fb75af6/9057fff) are API-layer reads; the
  GraphQL API serves both tables with relationship queries instead.
- Upstream's isolated per-chain sync (682d0ac — one ponder instance per chain, plus a
  patched ponder build) is unnecessary here: envio fetches each chain independently.
- One envio process serves every chain, and a batch's block handlers run one after
  another before any chain commits. A slow poller would hold back every chain, so:
  - Pollers are paced on wall-clock time (`paced` in `blockHandlerShared.ts`): one waits
    until 3× its last run's duration has passed, skipping firings meanwhile. Pollers
    read current state, so a skipped firing loses nothing. They also skip envio's
    preload pass.
  - FlashLoanOrderBackfiller drains the historical backlog one 500-order slice per
    firing instead of all at once.
  - PrecomputeBackfiller fetches statuses for all of a firing's generators in one
    batched lookup (≤500 UIDs).
- A by-UID lookup reports the UIDs it could not ask about (refused, failed or timed out).
  CandidateConfirmer's cancelled-parent cascade and expiry sweep leave those for a
  later block instead of recording them as cancelled or expired, and flash-loan
  enrichment doesn't count them as a failed attempt. Upstream finalizes them.

## Pre-requisites

- [Node.js v22.15+](https://nodejs.org/en/download/current), [pnpm](https://pnpm.io/installation),
  [Docker](https://www.docker.com/products/docker-desktop/) (for the local Postgres/Hasura).
