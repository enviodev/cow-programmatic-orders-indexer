# CoW Programmatic Orders Indexer

CoW Protocol Programmatic Orders Indexer (Composable CoW, COWShed ownership, GPv2 trade tracking). Built with [Envio HyperIndex](https://docs.envio.dev).

## Chains

| Network | Chain ID |
|---|---|
| Ethereum Mainnet | 1 |
| Gnosis | 100 |
| Arbitrum | 42161 |
| Base | 8453 |
| Sepolia | 11155111 |

## Contracts

- **`ComposableCoW`**: `ConditionalOrderCreated`, `MerkleRootSet`
- **`COWShedFactory`**: `COWShedBuilt`
- **`GPv2Settlement`**: `Trade`

## Schema entities (5)

`ConditionalOrder`, `MerkleRoot`, `OwnerMapping`, `Trade`, `OrderBookOrder`

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
