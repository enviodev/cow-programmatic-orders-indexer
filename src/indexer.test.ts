import { describe, it, expect } from "vitest";
import { TestHelpers } from "generated";

const { MockDb, ComposableCoW } = TestHelpers;

describe("ConditionalOrderCreated Handler", () => {
  it("should create a ConditionalOrder entity from a TWAP event", async () => {
    const mockDb = MockDb.createMockDb();

    // TWAP handler address (mainnet)
    const twapHandler = "0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5" as const;
    const mockSalt = "0x0000000000000000000000000000000000000000000000000000000000000001";
    // Minimal valid TWAP staticInput (10 fields encoded as tuple)
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
    expect(order.owner).toBe("0x1234567890123456789012345678901234567890");
    expect(order.handler).toBe(twapHandler.toLowerCase());
    expect(order.decodedParams).toBeDefined();
  });

  it("should handle unknown handler addresses gracefully", async () => {
    const mockDb = MockDb.createMockDb();

    const unknownHandler = "0x0000000000000000000000000000000000000042" as const;
    const mockSalt = "0x0000000000000000000000000000000000000000000000000000000000000001";
    const mockStaticInput = "0x00";

    const mockEvent = ComposableCoW.ConditionalOrderCreated.createMockEvent({
      owner: "0x1234567890123456789012345678901234567890",
      params: [unknownHandler, mockSalt, mockStaticInput],
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
    expect(order.orderType).toBe("Unknown");
    expect(order.decodedParams).toBeUndefined();
    expect(order.decodeError).toBeUndefined();
  });
});

describe("MerkleRootSet Handler", () => {
  it("should create a MerkleRoot entity", async () => {
    const mockDb = MockDb.createMockDb();

    const mockRoot = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

    const mockEvent = ComposableCoW.MerkleRootSet.createMockEvent({
      owner: "0x1234567890123456789012345678901234567890",
      root: mockRoot,
      proof: [0n, "0x"], // PRIVATE proof location
      mockEventData: {
        chainId: 100,
        block: { number: 29380001, timestamp: 1692000000 },
        transaction: {
          hash: "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678",
          from: "0x2222222222222222222222222222222222222222",
        },
      },
    });

    const result = await ComposableCoW.MerkleRootSet.processEvent({
      event: mockEvent,
      mockDb,
    });

    const roots = result.entities.MerkleRoot.getAll();
    expect(roots.length).toBe(1);

    const root = roots[0]!;
    expect(root.owner).toBe("0x1234567890123456789012345678901234567890");
    expect(root.root).toBe(mockRoot);
    expect(root.proofLocation).toBe(0);
    expect(root.chainId).toBe(100);
  });
});
