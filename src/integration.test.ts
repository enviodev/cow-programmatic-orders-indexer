import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";

// ═══════════════════════════════════════════════════════════════════════════
// Real-data integration tests using HyperSync
// These tests process actual on-chain data to validate handler logic against
// real blockchain events, catching issues that mock tests miss.
// Block handlers are not registered under VITEST (see blockHandlerShared.ts).
// ═══════════════════════════════════════════════════════════════════════════

// ─── ConditionalOrderGenerator creation from real events ───────────────────

describe("ConditionalOrderGenerator creation", () => {
  it("should create a generator from a real ConditionalOrderCreated event", async () => {
    const indexer = createTestIndexer();

    // Block 17891788 on mainnet has a real TWAP ConditionalOrderCreated event
    await indexer.process({
      chains: {
        1: { startBlock: 17891788, endBlock: 17891789 },
      },
    });

    const generators = await indexer.ConditionalOrderGenerator.getAll();
    expect(generators.length).toBeGreaterThanOrEqual(1);

    const twap = generators.find((g) => g.orderType === "TWAP");
    expect(twap).toBeDefined();
    expect(twap!.owner).toBe("0xe7602ca44f83a5e9ba8bd14125ddcb295f3d63bd");
    expect(twap!.handler).toBe("0x6cf1e9ca41f7611def408122793c358a3d11e5a5");
    // Precompute checks the orderbook at creation: if every part of this 2023
    // TWAP is terminal on the API the generator is completed immediately.
    expect(["Active", "Completed"]).toContain(twap!.status);
    expect(twap!.chainId).toBe(1);
    expect(twap!.hash).toMatch(/^0x[a-f0-9]{64}$/);
  }, 60_000);

  it("should decode TWAP params and precompute part orders from a real event", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        1: { startBlock: 17891788, endBlock: 17891789 },
      },
    });

    const twap = (await indexer.ConditionalOrderGenerator.getAll()).find(
      (g) => g.orderType === "TWAP",
    )!;
    expect(twap.decodedParams).toBeDefined();
    expect(twap.decodeError).toBeUndefined();

    const params = twap.decodedParams as Record<string, unknown>;
    expect(params.sellToken).toBeDefined();
    expect(params.buyToken).toBeDefined();
    expect(params.n).toBeDefined();
    expect(params.t).toBeDefined();

    // Deterministic type → precompute ran at creation: every part UID landed in
    // DiscreteOrder (known to the orderbook) or CandidateDiscreteOrder.
    expect(twap.allCandidatesKnown).toBe(true);
    const discrete = await indexer.DiscreteOrder.getAll();
    const candidates = await indexer.CandidateDiscreteOrder.getAll();
    expect(discrete.length + candidates.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("should upsert the Transaction row for the creating tx", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        1: { startBlock: 17891788, endBlock: 17891789 },
      },
    });

    const generators = await indexer.ConditionalOrderGenerator.getAll();
    const txs = await indexer.Transaction.getAll();
    expect(txs.length).toBeGreaterThanOrEqual(1);
    expect(txs[0]!.id).toBe(`1_${generators[0]!.txHash}`);
  }, 60_000);

  it("should index generators on Gnosis Chain", async () => {
    const indexer = createTestIndexer();

    const result = await indexer.process({
      chains: {
        100: { startBlock: 29389123, endBlock: 29400000 },
      },
    });

    // Should process Gnosis without errors; any generators found must be
    // namespaced to chain 100.
    expect(result.changes).toBeDefined();
    const generators = await indexer.ConditionalOrderGenerator.getAll();
    for (const gen of generators) {
      expect(gen.chainId).toBe(100);
      expect(gen.id).toMatch(/^100_/);
    }
  }, 60_000);
});

// ─── COWShed proxy creation ─────────────────────────────────────────────────

describe("COWShed proxy creation", () => {
  it("should create OwnerMapping from a real COWShedBuilt event", async () => {
    const indexer = createTestIndexer();

    // Block 22981721 has a real COWShedBuilt event on mainnet
    await indexer.process({
      chains: {
        1: { startBlock: 22981721, endBlock: 22981722 },
      },
    });

    const mappings = await indexer.OwnerMapping.getAll();
    expect(mappings.length).toBeGreaterThanOrEqual(1);

    const proxy = mappings.find(
      (p) => p.address === "0xadc605b8c1f31efce19d9cb1a26cfa4af7f2f4e4",
    );
    expect(proxy).toBeDefined();
    expect(proxy!.owner).toBe("0x9fa3c00a92ec5f96b1ad2527ab41b3932efeda58");
    expect(proxy!.chainId).toBe(1);
    expect(proxy!.addressType).toBe("cowshed_proxy");
    expect(proxy!.id).toBe(`1_${proxy!.address}`);
  }, 60_000);

  it("should create multiple OwnerMapping entities from batch deployment", async () => {
    const indexer = createTestIndexer();

    // Blocks 22982583-22982665 have a burst of COWShedBuilt events
    await indexer.process({
      chains: {
        1: { startBlock: 22982583, endBlock: 22982665 },
      },
    });

    const mappings = await indexer.OwnerMapping.getAll();
    expect(mappings.length).toBeGreaterThan(1);

    // Each proxy should have a unique address
    const addresses = new Set(mappings.map((p) => p.address));
    expect(addresses.size).toBe(mappings.length);

    for (const proxy of mappings) {
      expect(proxy.chainId).toBe(1);
      expect(proxy.address).toMatch(/^0x[a-f0-9]{40}$/);
      expect(proxy.owner).toMatch(/^0x[a-f0-9]{40}$/);
      expect(proxy.resolutionDepth).toBe(0);
    }
  }, 90_000);
});

// ─── Settlement (Aave flash-loan) ───────────────────────────────────────────

describe("Settlement indexing", () => {
  it("should process the settlement start range without errors", async () => {
    const indexer = createTestIndexer();

    // GPv2Settlement events are filtered to solver = Aave FlashLoanRouter, so
    // most blocks produce no events; this asserts the pipeline doesn't crash.
    const result = await indexer.process({
      chains: {
        1: { startBlock: 23812751, endBlock: 23813000 },
      },
    });

    expect(result.changes).toBeDefined();

    // Any flash-loan orders found must be fully formed
    const orders = await indexer.FlashLoanOrder.getAll();
    for (const order of orders) {
      expect(order.chainId).toBe(1);
      expect(order.orderUid).toMatch(/^0x[a-f0-9]+$/);
      expect(order.adapter).toMatch(/^0x[a-f0-9]{40}$/);
      expect(order.source).toBe("aave");
      expect(order.enriched).toBe(false);
    }
  }, 90_000);
});
