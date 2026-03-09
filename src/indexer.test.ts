import { describe, it, expect } from "vitest";
import { TestHelpers } from "generated";

const { MockDb, ComposableCoW, COWShedFactory, GPv2Settlement } = TestHelpers;

// ─── M1: ConditionalOrderCreated ────────────────────────────────────────────

describe("ConditionalOrderCreated Handler", () => {
  it("should create a ConditionalOrder entity from a TWAP event", async () => {
    const mockDb = MockDb.createMockDb();

    const twapHandler = "0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5" as const;
    const mockSalt = "0x0000000000000000000000000000000000000000000000000000000000000001";
    const mockStaticInput = "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000000e100000000000000000000000000000000000000000000000000000000000000000d26e16c7d99f1e205b3630f43fff7cb142bbdab5ad57196a0c0f0a2f72b734ea1";

    const mockEvent = ComposableCoW.ConditionalOrderCreated.createMockEvent({
      owner: "0x1234567890123456789012345678901234567890",
      params: [twapHandler, mockSalt, mockStaticInput],
      mockEventData: {
        chainId: 1,
        block: { number: 17883050, timestamp: 1692000000 },
        transaction: {
          hash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
          from: "0x1111111111111111111111111111111111111111",
        },
      },
    });

    const result = await ComposableCoW.ConditionalOrderCreated.processEvent({
      event: mockEvent,
      mockDb,
    });

    const orders = result.entities.ConditionalOrder.getAll();
    expect(orders.length).toBe(1);

    const order = orders[0]!;
    expect(order.orderType).toBe("TWAP");
    expect(order.status).toBe("Active");
    expect(order.chainId).toBe(1);
    expect(order.handler).toBe(twapHandler.toLowerCase());
    expect(order.decodedParams).toBeDefined();
  });

  it("should handle unknown handler addresses gracefully", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = ComposableCoW.ConditionalOrderCreated.createMockEvent({
      owner: "0x1234567890123456789012345678901234567890",
      params: [
        "0x0000000000000000000000000000000000000042" as const,
        "0x0000000000000000000000000000000000000000000000000000000000000001",
        "0x00",
      ],
      mockEventData: { chainId: 1 },
    });

    const result = await ComposableCoW.ConditionalOrderCreated.processEvent({
      event: mockEvent,
      mockDb,
    });

    const orders = result.entities.ConditionalOrder.getAll();
    expect(orders.length).toBe(1);
    expect(orders[0]!.orderType).toBe("Unknown");
    expect(orders[0]!.decodedParams).toBeUndefined();
  });
});

// ─── M1: MerkleRootSet ──────────────────────────────────────────────────────

describe("MerkleRootSet Handler", () => {
  it("should create a MerkleRoot entity", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = ComposableCoW.MerkleRootSet.createMockEvent({
      owner: "0x1234567890123456789012345678901234567890",
      root: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      proof: [0n, "0x"],
      mockEventData: { chainId: 100 },
    });

    const result = await ComposableCoW.MerkleRootSet.processEvent({
      event: mockEvent,
      mockDb,
    });

    const roots = result.entities.MerkleRoot.getAll();
    expect(roots.length).toBe(1);
    expect(roots[0]!.proofLocation).toBe(0);
    expect(roots[0]!.chainId).toBe(100);
  });
});

// ─── M2: COWShedBuilt ───────────────────────────────────────────────────────

describe("COWShedBuilt Handler", () => {
  it("should create a COWShedProxy entity mapping proxy to EOA", async () => {
    const mockDb = MockDb.createMockDb();

    const proxyAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
    const eoaOwner = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;

    const mockEvent = COWShedFactory.COWShedBuilt.createMockEvent({
      user: eoaOwner,
      shed: proxyAddress,
      mockEventData: {
        chainId: 1,
        block: { number: 18000000 },
        transaction: {
          hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
        },
      },
    });

    const result = await COWShedFactory.COWShedBuilt.processEvent({
      event: mockEvent,
      mockDb,
    });

    const proxies = result.entities.COWShedProxy.getAll();
    expect(proxies.length).toBe(1);
    expect(proxies[0]!.proxyAddress).toBe(proxyAddress);
    expect(proxies[0]!.eoaOwner).toBe(eoaOwner);
  });
});

// ─── M3: Trade ──────────────────────────────────────────────────────────────

describe("Trade Handler", () => {
  it("should create a Trade entity from GPv2Settlement", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = GPv2Settlement.Trade.createMockEvent({
      owner: "0x1234567890123456789012345678901234567890",
      sellToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      buyToken: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      sellAmount: 1000000n,
      buyAmount: 500000000000000000n,
      feeAmount: 1000n,
      orderUid: "0x" + "ab".repeat(56),
      mockEventData: {
        chainId: 1,
        block: { number: 18000000, timestamp: 1693000000 },
        transaction: {
          hash: "0x2222222222222222222222222222222222222222222222222222222222222222",
          from: "0x3333333333333333333333333333333333333333",
        },
      },
    });

    const result = await GPv2Settlement.Trade.processEvent({
      event: mockEvent,
      mockDb,
    });

    const trades = result.entities.Trade.getAll();
    expect(trades.length).toBe(1);

    const trade = trades[0]!;
    expect(trade.sellAmount).toBe(1000000n);
    expect(trade.buyAmount).toBe(500000000000000000n);
    expect(trade.chainId).toBe(1);
  });
});
