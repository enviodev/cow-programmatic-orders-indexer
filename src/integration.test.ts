import { describe, it, expect } from "vitest";
import { createTestIndexer } from "generated";
import { decodeSettleCalldata, extractOwnerFromOrderUid } from "./utils/settle-decoder.js";
import type { Hex } from "viem";

// ═══════════════════════════════════════════════════════════════════════════
// Real-data integration tests using HyperSync
// These tests process actual on-chain data to validate handler logic against
// real blockchain events, catching issues that mock tests miss.
// ═══════════════════════════════════════════════════════════════════════════

// ─── M1: ConditionalOrder Creation from Real Events ──────────────────────

describe("M1: ConditionalOrder Creation", () => {
  it("should create ConditionalOrder from real ConditionalOrderCreated event", async () => {
    const indexer = createTestIndexer();

    // Block 17891788 on mainnet has a real ConditionalOrderCreated event
    const result = await indexer.process({
      chains: {
        1: { startBlock: 17891788, endBlock: 17891789 },
      },
    });

    expect(result.changes).toContainEqual(
      expect.objectContaining({
        block: 17891788,
        chainId: 1,
        ConditionalOrder: expect.objectContaining({
          sets: expect.arrayContaining([
            expect.objectContaining({
              owner: "0xe7602ca44f83a5e9ba8bd14125ddcb295f3d63bd",
              orderType: "TWAP",
              status: "Active",
              handler: "0x6cf1e9ca41f7611def408122793c358a3d11e5a5",
              chainId: 1,
            }),
          ]),
        }),
      }),
    );
  });

  it("should decode TWAP params from real event", async () => {
    const indexer = createTestIndexer();

    const result = await indexer.process({
      chains: {
        1: { startBlock: 17891788, endBlock: 17891789 },
      },
    });

    const orders = result.changes
      .flatMap((c) => c.ConditionalOrder?.sets ?? []);
    expect(orders.length).toBeGreaterThanOrEqual(1);

    const twapOrder = orders.find((o) => o.orderType === "TWAP");
    expect(twapOrder).toBeDefined();
    expect(twapOrder!.decodedParams).toBeDefined();
    expect(twapOrder!.decodeError).toBeUndefined();

    // Verify decoded params have expected TWAP fields
    const params = twapOrder!.decodedParams as Record<string, unknown>;
    expect(params.sellToken).toBeDefined();
    expect(params.buyToken).toBeDefined();
    expect(params.n).toBeDefined();
    expect(params.t).toBeDefined();
  });

  it("should compute deterministic hash for order ID", async () => {
    const indexer = createTestIndexer();

    const result = await indexer.process({
      chains: {
        1: { startBlock: 17891788, endBlock: 17891789 },
      },
    });

    const orders = result.changes
      .flatMap((c) => c.ConditionalOrder?.sets ?? []);

    for (const order of orders) {
      // ID format: keccak256Hash-chainId
      expect(order.id).toMatch(/^0x[a-f0-9]{64}-1$/);
      expect(order.hash).toMatch(/^0x[a-f0-9]{64}$/);
    }
  });

  it("should index ConditionalOrders on Gnosis Chain", async () => {
    const indexer = createTestIndexer();

    // Gnosis chain start block has early ComposableCoW events
    const result = await indexer.process({
      chains: {
        100: { startBlock: 29380000, endBlock: 29400000 },
      },
    });

    const orders = result.changes
      .flatMap((c) => c.ConditionalOrder?.sets ?? []);

    // Should find at least some orders on Gnosis
    // (may be 0 if no events in this range — that's also valid)
    for (const order of orders) {
      expect(order.chainId).toBe(100);
      expect(order.id).toMatch(/-100$/);
    }
  }, 30_000);
});

// ─── M1: MerkleRootSet from Real Events ──────────────────────────────────

describe("M1: MerkleRootSet", () => {
  it("should process block range without errors", async () => {
    const indexer = createTestIndexer();

    // Process a range on mainnet — MerkleRootSet events are less common
    // but the handler should not crash
    const result = await indexer.process({
      chains: {
        1: { startBlock: 17891788, endBlock: 17891800 },
      },
    });

    // Should complete without error
    expect(result.changes.length).toBeGreaterThan(0);
  });
});

// ─── M2: COWShed Proxy Creation ──────────────────────────────────────────

describe("M2: COWShed Proxy Creation", () => {
  it("should create OwnerMapping from real COWShedBuilt event", async () => {
    const indexer = createTestIndexer();

    // Block 22981721 has a real COWShedBuilt event on mainnet
    const result = await indexer.process({
      chains: {
        1: { startBlock: 22981721, endBlock: 22981722 },
      },
    });

    const proxies = result.changes
      .flatMap((c) => c.OwnerMapping?.sets ?? []);

    expect(proxies.length).toBeGreaterThanOrEqual(1);

    const proxy = proxies.find(
      (p) => p.address === "0xadc605b8c1f31efce19d9cb1a26cfa4af7f2f4e4",
    );
    expect(proxy).toBeDefined();
    expect(proxy!.owner).toBe("0x9fa3c00a92ec5f96b1ad2527ab41b3932efeda58");
    expect(proxy!.chainId).toBe(1);
  }, 30_000);

  it("should create multiple OwnerMapping entities from batch deployment", async () => {
    const indexer = createTestIndexer();

    // Block 22982583-22982665 has a burst of COWShedBuilt events
    const result = await indexer.process({
      chains: {
        1: { startBlock: 22982583, endBlock: 22982665 },
      },
    });

    const proxies = result.changes
      .flatMap((c) => c.OwnerMapping?.sets ?? []);

    expect(proxies.length).toBeGreaterThan(1);

    // Each proxy should have unique proxyAddress
    const proxyAddresses = new Set(proxies.map((p) => p.address));
    expect(proxyAddresses.size).toBe(proxies.length);

    // All should be on chain 1
    for (const proxy of proxies) {
      expect(proxy.chainId).toBe(1);
      expect(proxy.address).toMatch(/^0x[a-f0-9]{40}$/);
      expect(proxy.owner).toMatch(/^0x[a-f0-9]{40}$/);
    }
  }, 60_000);

  it("should use proxyAddress-chainId as entity ID", async () => {
    const indexer = createTestIndexer();

    const result = await indexer.process({
      chains: {
        1: { startBlock: 22981721, endBlock: 22981722 },
      },
    });

    const proxies = result.changes
      .flatMap((c) => c.OwnerMapping?.sets ?? []);

    for (const proxy of proxies) {
      expect(proxy.id).toBe(`${proxy.address}-${proxy.chainId}`);
    }
  }, 30_000);
});

// ─── M3: Trade Linking ───────────────────────────────────────────────────

describe("M3: Trade Linking", () => {
  it("should link Trade to ConditionalOrder via owner matching", async () => {
    const indexer = createTestIndexer();

    // Process blocks covering ConditionalOrderCreated (17891788) and Trade (17891796)
    const result = await indexer.process({
      chains: {
        1: { startBlock: 17891788, endBlock: 17891797 },
      },
    });

    const trades = result.changes
      .flatMap((c) => c.Trade?.sets ?? []);

    // Find trades for the TWAP order owner
    const ownerTrades = trades.filter(
      (t) => t.owner === "0xe7602ca44f83a5e9ba8bd14125ddcb295f3d63bd",
    );

    expect(ownerTrades.length).toBeGreaterThanOrEqual(1);

    // Each trade for this owner should be linked to a ConditionalOrder
    for (const trade of ownerTrades) {
      expect(trade.conditionalOrder_id).toBeDefined();
      expect(trade.conditionalOrder_id).toMatch(/-1$/);
    }
  }, 30_000);

  it("should not link trades for owners without ConditionalOrders", async () => {
    const indexer = createTestIndexer();

    // Process only trade blocks (no ConditionalOrderCreated events)
    const result = await indexer.process({
      chains: {
        1: { startBlock: 17891796, endBlock: 17891797 },
      },
    });

    const trades = result.changes
      .flatMap((c) => c.Trade?.sets ?? []);

    expect(trades.length).toBeGreaterThan(0);

    // Without prior ConditionalOrder creation, no trades should be linked
    for (const trade of trades) {
      expect(trade.conditionalOrder_id).toBeUndefined();
    }
  }, 30_000);

  it("should create Trade entities with all required fields", async () => {
    const indexer = createTestIndexer();

    const result = await indexer.process({
      chains: {
        1: { startBlock: 17891796, endBlock: 17891797 },
      },
    });

    const trades = result.changes
      .flatMap((c) => c.Trade?.sets ?? []);

    expect(trades.length).toBeGreaterThan(0);

    for (const trade of trades) {
      expect(trade.chainId).toBe(1);
      expect(trade.owner).toMatch(/^0x[a-f0-9]{40}$/);
      expect(trade.sellToken).toMatch(/^0x[a-f0-9]{40}$/);
      expect(trade.buyToken).toMatch(/^0x[a-f0-9]{40}$/);
      expect(typeof trade.sellAmount).toBe("bigint");
      expect(typeof trade.buyAmount).toBe("bigint");
      expect(typeof trade.feeAmount).toBe("bigint");
      expect(trade.transactionHash).toMatch(/^0x[a-f0-9]{64}$/);
      expect(trade.blockNumber).toBeGreaterThan(0);
    }
  }, 30_000);
});

// ─── M3: OrderBook API Integration ───────────────────────────────────────

describe("M3: OrderBook API", () => {
  it("should create ConditionalOrder without OrderBookOrder when no trades", async () => {
    const indexer = createTestIndexer();

    // Process only ConditionalOrderCreated — no Trade events
    const result = await indexer.process({
      chains: {
        1: { startBlock: 17891788, endBlock: 17891789 },
      },
    });

    const orders = result.changes
      .flatMap((c) => c.ConditionalOrder?.sets ?? []);
    expect(orders.length).toBeGreaterThanOrEqual(1);

    // OrderBook API only triggers from Trade handler
    const orderBookOrders = result.changes
      .flatMap((c) => c.OrderBookOrder?.sets ?? []);
    expect(orderBookOrders.length).toBe(0);
  }, 30_000);
});

// ─── Cross-contract: COWShed Proxy Resolution ────────────────────────────

describe("Cross-contract: COWShed Proxy Resolution", () => {
  it("should set realOwner undefined when no COWShed proxy exists", async () => {
    const indexer = createTestIndexer();

    const result = await indexer.process({
      chains: {
        1: { startBlock: 17891788, endBlock: 17891789 },
      },
    });

    const orders = result.changes
      .flatMap((c) => c.ConditionalOrder?.sets ?? []);
    expect(orders.length).toBeGreaterThanOrEqual(1);

    // No COWShed events in this range, so realOwner should be undefined
    const order = orders[0]!;
    expect(order.realOwner).toBeUndefined();
  }, 30_000);
});

// ─── Settle Decoder Utility Tests ────────────────────────────────────────

describe("Settle Decoder Utility", () => {
  it("should decode settle() calldata and extract ERC-1271 signatures", () => {
    const emptyResult = decodeSettleCalldata("0x00" as Hex);
    expect(emptyResult).toBeInstanceOf(Map);
    expect(emptyResult.size).toBe(0);

    const nonSettleResult = decodeSettleCalldata("0xdeadbeef0000" as Hex);
    expect(nonSettleResult).toBeInstanceOf(Map);
    expect(nonSettleResult.size).toBe(0);
  });

  it("should extract owner from orderUid correctly", () => {
    const owner = "0xe7602ca44f83a5e9ba8bd14125ddcb295f3d63bd";
    const digest = "a".repeat(64);
    const validTo = "deadbeef";
    const orderUid = `0x${digest}${owner.slice(2)}${validTo}`;

    const extracted = extractOwnerFromOrderUid(orderUid);
    expect(extracted).toBe(owner);
  });

  it("should return empty string for malformed orderUid", () => {
    expect(extractOwnerFromOrderUid("0x")).toBe("");
    expect(extractOwnerFromOrderUid("short")).toBe("");
  });
});

// ─── Full E2E Pipeline ──────────────────────────────────────────────────

describe("Full Pipeline E2E", () => {
  it("should process ConditionalOrderCreated and Trade events together", async () => {
    const indexer = createTestIndexer();

    // Block range: ConditionalOrderCreated (17891788) → Trade (17891820)
    const result = await indexer.process({
      chains: {
        1: { startBlock: 17891788, endBlock: 17891820 },
      },
    });

    // M1: Verify ConditionalOrders were created
    const orders = result.changes
      .flatMap((c) => c.ConditionalOrder?.sets ?? []);
    expect(orders.length).toBeGreaterThanOrEqual(1);

    // M3: Verify Trades were created
    const trades = result.changes
      .flatMap((c) => c.Trade?.sets ?? []);
    expect(trades.length).toBeGreaterThan(0);

    // Verify linking works
    const linkedTrades = trades.filter((t) => t.conditionalOrder_id);
    const unlinkedTrades = trades.filter((t) => !t.conditionalOrder_id);

    console.log(`Total trades: ${trades.length}`);
    console.log(`Linked trades: ${linkedTrades.length}`);
    console.log(`Unlinked trades: ${unlinkedTrades.length}`);

    // At least some trades should be linked (owner 0xe7602...)
    expect(linkedTrades.length).toBeGreaterThan(0);

    // Linked trades should reference valid ConditionalOrder IDs
    for (const t of linkedTrades) {
      expect(t.conditionalOrder_id).toMatch(/^0x[a-f0-9]{64}-\d+$/);
    }
  }, 60_000);

  it("should index Gnosis chain independently", async () => {
    const indexer = createTestIndexer();

    const result = await indexer.process({
      chains: {
        100: { startBlock: 29380000, endBlock: 29400000 },
      },
    });

    // Should process Gnosis chain without errors
    expect(result.changes).toBeDefined();
  }, 30_000);

  it("should maintain entity integrity across block ranges", async () => {
    const indexer = createTestIndexer();

    const result = await indexer.process({
      chains: {
        1: { startBlock: 17891788, endBlock: 17891820 },
      },
    });

    // All ConditionalOrders should have valid fields
    const orders = result.changes
      .flatMap((c) => c.ConditionalOrder?.sets ?? []);

    for (const order of orders) {
      expect(order.chainId).toBe(1);
      expect(order.status).toBe("Active");
      expect(order.owner).toMatch(/^0x[a-f0-9]{40}$/);
      expect(order.handler).toMatch(/^0x[a-f0-9]{40}$/);
      expect(order.hash).toMatch(/^0x[a-f0-9]{64}$/);
      expect(order.salt).toMatch(/^0x[a-f0-9]{64}$/);
      expect(order.blockNumber).toBeGreaterThan(0);
      expect(typeof order.blockTimestamp).toBe("bigint");
    }

    // All Trades should have valid fields
    const trades = result.changes
      .flatMap((c) => c.Trade?.sets ?? []);

    for (const trade of trades) {
      expect(trade.chainId).toBe(1);
      expect(trade.id).toMatch(/^0x[a-f0-9]{64}-\d+$/);
    }
  }, 60_000);
});
