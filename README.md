# CoW Programmatic Orders Indexer (Envio)

Envio HyperIndex port of the [CoW programmatic orders ponder indexer](../cow-programmatic-orders-api)
(now maintained as [cowprotocol/cow-programmatic-orders-api](https://github.com/cowprotocol/cow-programmatic-orders-api)),
kept 1:1 with upstream's indexing behaviour. Mapped through upstream commit
`47b2601` (behavioral content through `ff0fd96`; later commits are CI/deploy/API-only). Indexes Composable CoW conditional-order
generators, the discrete-order lifecycle (UID precompute → candidate → orderbook-confirmed),
COWShed proxy ownership, and Aave V3 flash-loan orders on **mainnet + gnosis**.

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
- Optional caps: `MAX_GENERATORS_PER_BLOCK_<chainId>`, `MAX_DISCRETE_ORDERS_PER_BLOCK_<chainId>`,
  `MAX_OWNERS_BACKFILL_PER_BLOCK_<chainId>`, `MAX_FLASH_LOAN_ORDERS_PER_BLOCK_<chainId>`,
  `MAX_PRECOMPUTES_PER_BLOCK_<chainId>`, `MAX_SCAN_RETRIES_PER_BLOCK_<chainId>`,
  `ORDERBOOK_CONCURRENCY`, `POLLER_FLOOR_FROM_HEAD=1` (skip historical poller firings),
  `POLLER_ACTIVATION_BLOCK_<chainId>`, `DISABLE_SETTLEMENT_FACTORY_CHECK`.

## CoW Orderbook API budget

api.cow.fi enforces ~100 requests/minute per IP per read endpoint (documented),
with a Cloudflare layer that escalates sustained abuse to 30s+ penalties. The
effects encode this: `by_uids` 80/min (×100 UIDs/request), `account` 40/min,
plus a shared concurrency semaphore and full `Retry-After` honoring. For
elevated limits CoW suggests contacting bd@cow.fi.

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

## Pre-requisites

- [Node.js v22+](https://nodejs.org/en/download/current), [pnpm](https://pnpm.io/installation),
  [Docker](https://www.docker.com/products/docker-desktop/) (for the local Postgres/Hasura).
