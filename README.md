# CoW Programmatic Orders Indexer

A multichain CoW Protocol indexer focused on programmatic orders, COWShed ownership mappings, and GPv2 trade tracking. Built with [Envio HyperIndex](https://docs.envio.dev).

## Chains

| Chain | ID |
|---|---|
| Ethereum Mainnet | 1 |
| Gnosis Chain | 100 |
| Base | 8453 |
| Arbitrum One | 42161 |
| Sepolia (testnet) | 11155111 |

## What it indexes

- **`ComposableCoW`**: `ConditionalOrderCreated`, `MerkleRootSet`. Captures the conditional-order schemes attached to each owner and any Merkle-root commitments.
- **`COWShedFactory`**: `COWShedBuilt`. Maps each COWShed contract to its underlying owner.
- **`GPv2Settlement`**: `Trade`. Captures fills produced by the CoW settlement contract.

## Schema

5 GraphQL entities:

- `ConditionalOrder`: programmatic conditional order definitions
- `MerkleRoot`: per-owner Merkle-root commitments
- `OwnerMapping`: COWShed-to-owner relationships
- `Trade`: GPv2 settlement fills
- `OrderBookOrder`: orderbook-tracked orders

## Run locally

```bash
pnpm install
pnpm dev
```

GraphQL playground at [http://localhost:8080](http://localhost:8080) (local password: `testing`).

## Generate from `config.yaml` or `schema.graphql`

```bash
pnpm codegen
```

## Pre-requisites

- [Node.js v22+ (v24 recommended)](https://nodejs.org/en/download/current)
- [pnpm](https://pnpm.io/installation)
- [Docker](https://www.docker.com/products/docker-desktop/) or [Podman](https://podman.io/)

## Resources

- [Envio docs](https://docs.envio.dev)
- [HyperIndex overview](https://docs.envio.dev/docs/HyperIndex/overview)
- [Discord](https://discord.gg/envio)
