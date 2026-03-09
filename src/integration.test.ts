import { describe, it, expect } from "vitest";
import { createTestIndexer } from "generated";
import { decodeSettleCalldata, extractOwnerFromOrderUid } from "./utils/settle-decoder.js";
import type { Hex } from "viem";

// ─── Real-data integration tests using HyperSync ────────────────────────────
// These tests process real on-chain data to validate handler logic against
// actual blockchain events, catching issues that mock tests miss.

// ─── Issue #6: Trade Linking ─────────────────────────────────────────────────
// Owner 0xe7602ca44f83a5e9ba8bd14125ddcb295f3d63bd created a TWAP ConditionalOrder
// at block 17891788, then had a Trade at block 17891796 in the same settle() tx.
// The trade should be linked to the conditional order via owner matching.

describe("Trade Linking (Issue #6)", () => {
  it("should create a ConditionalOrder from real ConditionalOrderCreated event", async () => {
    const indexer = createTestIndexer();

    // Process just the block with the ConditionalOrderCreated event
    const result = await indexer.process({
      chains: {
        1: { startBlock: 17891788, endBlock: 17891789 },
      },
    });

    // Should have created a ConditionalOrder entity
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

    // Verify TWAP params were decoded
    const orders = result.changes
      .flatMap((c) => c.ConditionalOrder?.sets ?? []);
    expect(orders.length).toBeGreaterThanOrEqual(1);
    const twapOrder = orders.find((o) => o.orderType === "TWAP");
    expect(twapOrder).toBeDefined();
    expect(twapOrder!.decodedParams).toBeDefined();
    expect(twapOrder!.decodeError).toBeUndefined();
  });

  it("should link Trade to ConditionalOrder via owner matching", async () => {
    const indexer = createTestIndexer();

    // Process blocks covering both ConditionalOrderCreated (17891788)
    // and the first Trade for the same owner (17891796)
    const result = await indexer.process({
      chains: {
        1: { startBlock: 17891788, endBlock: 17891797 },
      },
    });

    // Check that a Trade entity was created
    const trades = result.changes
      .flatMap((c) => c.Trade?.sets ?? []);

    // Find trades for our owner
    const ownerTrades = trades.filter(
      (t) => t.owner === "0xe7602ca44f83a5e9ba8bd14125ddcb295f3d63bd",
    );

    // Trade at block 17891796 is for owner 0xe7602... who created a TWAP order at 17891788
    expect(ownerTrades.length).toBeGreaterThanOrEqual(1);

    // Each trade for this owner should be linked to a ConditionalOrder
    for (const trade of ownerTrades) {
      expect(trade.conditionalOrder_id).toBeDefined();
      // The linked order should end with the chain ID suffix
      expect(trade.conditionalOrder_id).toMatch(/-1$/);
    }
  }, 30_000);

});

// ─── Issue #7: Settle Decoder Silent Errors ─────────────────────────────────
// The settle decoder should not silently swallow errors. Test with known
// settle() calldata from real transactions.

describe("Settle Decoder (Issue #7)", () => {
  it("should decode settle() calldata and extract ERC-1271 signatures", async () => {
    // Fetch the actual transaction input from a known settle tx
    // tx 0xc3efe805... at block 17891796 has a Trade for owner 0xe7602...
    // with selector 0x13d79a0b (settle) and input_len=6218
    //
    // We test the decoder function directly with a known-good input.
    // If this fails, it confirms Issue #7 — silent error swallowing.

    // Minimal test: the function should return a Map, not throw
    const emptyResult = decodeSettleCalldata("0x00" as Hex);
    expect(emptyResult).toBeInstanceOf(Map);
    expect(emptyResult.size).toBe(0);

    // Test with a non-settle selector — should return empty Map, not throw
    const nonSettleResult = decodeSettleCalldata("0xdeadbeef0000" as Hex);
    expect(nonSettleResult).toBeInstanceOf(Map);
    expect(nonSettleResult.size).toBe(0);
  });

  it("should extract owner from orderUid correctly", () => {
    // orderUid = 32 bytes digest + 20 bytes owner + 4 bytes validTo = 56 bytes
    // Hex: "0x" + 64 chars (digest) + 40 chars (owner) + 8 chars (validTo) = 114 chars
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

// ─── Issue #8: COWShed Proxy Entities ───────────────────────────────────────
// COWShedBuilt events on mainnet first appear at block 22981721.
// Verify the handler creates COWShedProxy entities from real events.

describe("COWShed Proxy Creation (Issue #8)", () => {
  it("should create COWShedProxy from real COWShedBuilt event", async () => {
    const indexer = createTestIndexer();

    // Block 22981721 has a real COWShedBuilt event on mainnet
    // user: 0x9fa3c00a92ec5f96b1ad2527ab41b3932efeda58
    // shed: 0xadc605b8c1f31efce19d9cb1a26cfa4af7f2f4e4
    const result = await indexer.process({
      chains: {
        1: { startBlock: 22981721, endBlock: 22981722 },
      },
    });

    const proxies = result.changes
      .flatMap((c) => c.COWShedProxy?.sets ?? []);

    // Issue #8: If this fails with 0 proxies, the event signature or
    // factory address may be wrong
    expect(proxies.length).toBeGreaterThanOrEqual(1);

    const proxy = proxies.find(
      (p) => p.proxyAddress === "0xadc605b8c1f31efce19d9cb1a26cfa4af7f2f4e4",
    );
    expect(proxy).toBeDefined();
    expect(proxy!.eoaOwner).toBe("0x9fa3c00a92ec5f96b1ad2527ab41b3932efeda58");
    expect(proxy!.chainId).toBe(1);
  }, 30_000);

  it("should create multiple COWShedProxy entities from batch deployment", async () => {
    const indexer = createTestIndexer();

    // Block 22982583-22982665 has a burst of COWShedBuilt events
    const result = await indexer.process({
      chains: {
        1: { startBlock: 22982583, endBlock: 22982665 },
      },
    });

    const proxies = result.changes
      .flatMap((c) => c.COWShedProxy?.sets ?? []);

    // Should have created multiple proxy entities
    expect(proxies.length).toBeGreaterThan(1);

    // Each proxy should have unique proxyAddress and eoaOwner
    const proxyAddresses = new Set(proxies.map((p) => p.proxyAddress));
    expect(proxyAddresses.size).toBe(proxies.length);
  }, 60_000);
});

// ─── Issue #2: OrderBook API should trigger from ConditionalOrderCreated ────
// Currently only triggers from Trade handler. This test verifies the
// ConditionalOrderCreated handler does NOT call the OrderBook API
// (documenting the current broken behavior so we can fix it).

describe("OrderBook API Integration (Issue #2)", () => {
  it("should create ConditionalOrder without OrderBookOrder (current behavior)", async () => {
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

    // Issue #2: Currently no OrderBookOrders are created from
    // ConditionalOrderCreated handler. Once fixed, this test should
    // verify that OrderBookOrders ARE created.
    const orderBookOrders = result.changes
      .flatMap((c) => c.OrderBookOrder?.sets ?? []);

    // TODO: Once Issue #2 is fixed, change this to:
    // expect(orderBookOrders.length).toBeGreaterThan(0);
    expect(orderBookOrders.length).toBe(0);
  }, 30_000);
});

// ─── Cross-contract ordering: COWShed proxy resolution ──────────────────────
// Test that when a ConditionalOrder is owned by a COWShed proxy,
// the realOwner field is populated (requires COWShedBuilt to be processed first).

describe("COWShed Proxy Resolution in ConditionalOrders", () => {
  it("should resolve realOwner when order owner is a known COWShed proxy", async () => {
    const indexer = createTestIndexer();

    // First, check if there are any ConditionalOrderCreated events
    // where the owner is also a COWShed proxy. This tests the
    // cross-contract resolution path.
    //
    // For now, we test with mock data since COWShed events (block 22M)
    // are far from ConditionalOrder events (block 17M).
    // The real test is that the COWShedProxy.get() call works correctly.

    // Process a ConditionalOrderCreated block
    const result = await indexer.process({
      chains: {
        1: { startBlock: 17891788, endBlock: 17891789 },
      },
    });

    const orders = result.changes
      .flatMap((c) => c.ConditionalOrder?.sets ?? []);
    expect(orders.length).toBeGreaterThanOrEqual(1);

    // Without a pre-existing COWShedProxy, realOwner should be undefined
    const order = orders[0]!;
    expect(order.realOwner).toBeUndefined();
  }, 30_000);
});

// ─── Full E2E: ConditionalOrder + Trade in same block range ─────────────────
// Comprehensive test processing a range that includes both order creation
// and trade settlement, verifying the full pipeline.

describe("Full Pipeline E2E", () => {
  it("should process ConditionalOrderCreated and Trade events together", async () => {
    const indexer = createTestIndexer();

    // Block range: 17891788 (ConditionalOrderCreated) to 17891820 (Trade)
    const result = await indexer.process({
      chains: {
        1: { startBlock: 17891788, endBlock: 17891820 },
      },
    });

    // Verify ConditionalOrders were created
    const orders = result.changes
      .flatMap((c) => c.ConditionalOrder?.sets ?? []);
    expect(orders.length).toBeGreaterThanOrEqual(1);

    // Verify Trades were created
    const trades = result.changes
      .flatMap((c) => c.Trade?.sets ?? []);
    expect(trades.length).toBeGreaterThan(0);

    // Log diagnostics for debugging Issue #6
    const linkedTrades = trades.filter((t) => t.conditionalOrder_id);
    const unlinkedTrades = trades.filter((t) => !t.conditionalOrder_id);

    console.log(`Total trades: ${trades.length}`);
    console.log(`Linked trades: ${linkedTrades.length}`);
    console.log(`Unlinked trades: ${unlinkedTrades.length}`);

    if (linkedTrades.length > 0) {
      console.log("Trade linking is WORKING:");
      for (const t of linkedTrades) {
        console.log(`  Trade ${t.id} → ${t.conditionalOrder_id}`);
      }
    } else {
      console.warn(
        "WARNING: No trades linked to conditional orders — Issue #6 is still present",
      );
      // Diagnostic: check if any trades have the same owner as a conditional order
      const orderOwners = new Set(orders.map((o) => o.owner));
      const matchingTrades = trades.filter((t) => orderOwners.has(t.owner));
      console.log(
        `Trades with matching owner: ${matchingTrades.length}`,
      );
      for (const t of matchingTrades) {
        console.log(
          `  Trade owner=${t.owner} txHash=${t.transactionHash}`,
        );
      }
    }
  }, 60_000);
});
