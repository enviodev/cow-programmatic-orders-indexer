import { describe, it, expect } from "vitest";
import { TestHelpers } from "generated";
import { getOrderTypeFromHandler } from "./utils/order-types.js";
import { decodeSettleCalldata, extractOwnerFromOrderUid } from "./utils/settle-decoder.js";
import { decodeStaticInput } from "./decoders/index.js";
import { decodeTwapStaticInput } from "./decoders/twap.js";
import type { Hex } from "viem";

const { MockDb, ComposableCoW, COWShedFactory, GPv2Settlement } = TestHelpers;

// ═══════════════════════════════════════════════════════════════════════════
// M1: ConditionalOrderCreated Handler
// ═══════════════════════════════════════════════════════════════════════════

describe("ConditionalOrderCreated Handler", () => {
  // Real TWAP staticInput from mainnet block 17891788
  const REAL_TWAP_STATIC_INPUT =
    "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000000e100000000000000000000000000000000000000000000000000000000000000000d26e16c7d99f1e205b3630f43fff7cb142bbdab5ad57196a0c0f0a2f72b734ea1";

  const TWAP_HANDLER = "0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5" as const;
  const MOCK_SALT = "0x0000000000000000000000000000000000000000000000000000000000000001";

  it("should create a ConditionalOrder entity from a TWAP event", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = ComposableCoW.ConditionalOrderCreated.createMockEvent({
      owner: "0x1234567890123456789012345678901234567890",
      params: [TWAP_HANDLER, MOCK_SALT, REAL_TWAP_STATIC_INPUT],
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
    expect(order.handler).toBe(TWAP_HANDLER.toLowerCase());
    expect(order.decodedParams).toBeDefined();
  });

  it("should decode TWAP params correctly", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = ComposableCoW.ConditionalOrderCreated.createMockEvent({
      owner: "0x1234567890123456789012345678901234567890",
      params: [TWAP_HANDLER, MOCK_SALT, REAL_TWAP_STATIC_INPUT],
      mockEventData: { chainId: 1 },
    });

    const result = await ComposableCoW.ConditionalOrderCreated.processEvent({
      event: mockEvent,
      mockDb,
    });

    const order = result.entities.ConditionalOrder.getAll()[0]!;
    const params = order.decodedParams as Record<string, unknown>;

    // Verify decoded params have expected TWAP structure
    expect(params.sellToken).toBeDefined();
    expect(params.buyToken).toBeDefined();
    expect(params.n).toBeDefined();
    expect(params.t).toBeDefined();
    expect(params.partSellAmount).toBeDefined();
    expect(params.minPartLimit).toBeDefined();
  });

  it("should handle unknown handler addresses gracefully", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = ComposableCoW.ConditionalOrderCreated.createMockEvent({
      owner: "0x1234567890123456789012345678901234567890",
      params: [
        "0x0000000000000000000000000000000000000042" as const,
        MOCK_SALT,
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
    expect(orders[0]!.decodeError).toBeUndefined();
  });

  it("should compute deterministic order ID from params", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = ComposableCoW.ConditionalOrderCreated.createMockEvent({
      owner: "0x1234567890123456789012345678901234567890",
      params: [TWAP_HANDLER, MOCK_SALT, REAL_TWAP_STATIC_INPUT],
      mockEventData: { chainId: 1 },
    });

    const result = await ComposableCoW.ConditionalOrderCreated.processEvent({
      event: mockEvent,
      mockDb,
    });

    const order = result.entities.ConditionalOrder.getAll()[0]!;
    // ID should be hash-chainId format
    expect(order.id).toMatch(/^0x[a-f0-9]{64}-1$/);
    // Hash should be a valid keccak256
    expect(order.hash).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it("should set decodeError for malformed staticInput", async () => {
    const mockDb = MockDb.createMockDb();

    // TWAP handler with garbage staticInput
    const mockEvent = ComposableCoW.ConditionalOrderCreated.createMockEvent({
      owner: "0x1234567890123456789012345678901234567890",
      params: [TWAP_HANDLER, MOCK_SALT, "0xdeadbeef"],
      mockEventData: { chainId: 1 },
    });

    const result = await ComposableCoW.ConditionalOrderCreated.processEvent({
      event: mockEvent,
      mockDb,
    });

    const order = result.entities.ConditionalOrder.getAll()[0]!;
    expect(order.orderType).toBe("TWAP");
    expect(order.decodedParams).toBeUndefined();
    expect(order.decodeError).toBe("invalid_static_input");
  });

  it("should lowercase owner and handler addresses", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = ComposableCoW.ConditionalOrderCreated.createMockEvent({
      owner: "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
      params: [TWAP_HANDLER, MOCK_SALT, REAL_TWAP_STATIC_INPUT],
      mockEventData: { chainId: 1 },
    });

    const result = await ComposableCoW.ConditionalOrderCreated.processEvent({
      event: mockEvent,
      mockDb,
    });

    const order = result.entities.ConditionalOrder.getAll()[0]!;
    expect(order.owner).toBe("0xabcdef1234567890abcdef1234567890abcdef12");
    expect(order.handler).toBe(TWAP_HANDLER.toLowerCase());
  });

  it("should resolve COWShed proxy owner if proxy exists", async () => {
    const mockDb = MockDb.createMockDb();
    const proxyAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const eoaOwner = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    // Pre-populate a OwnerMapping
    const proxyEvent = COWShedFactory.COWShedBuilt.createMockEvent({
      user: eoaOwner as `0x${string}`,
      shed: proxyAddress as `0x${string}`,
      mockEventData: { chainId: 1, block: { number: 17000000 } },
    });
    const dbWithProxy = await COWShedFactory.COWShedBuilt.processEvent({
      event: proxyEvent,
      mockDb,
    });

    // Create ConditionalOrder owned by the proxy
    const orderEvent = ComposableCoW.ConditionalOrderCreated.createMockEvent({
      owner: proxyAddress as `0x${string}`,
      params: [TWAP_HANDLER, MOCK_SALT, REAL_TWAP_STATIC_INPUT],
      mockEventData: { chainId: 1 },
    });

    const result = await ComposableCoW.ConditionalOrderCreated.processEvent({
      event: orderEvent,
      mockDb: dbWithProxy,
    });

    const order = result.entities.ConditionalOrder.getAll()[0]!;
    expect(order.realOwner).toBe(eoaOwner);
  });

  it("should set realOwner undefined when no proxy exists", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = ComposableCoW.ConditionalOrderCreated.createMockEvent({
      owner: "0x1234567890123456789012345678901234567890",
      params: [TWAP_HANDLER, MOCK_SALT, REAL_TWAP_STATIC_INPUT],
      mockEventData: { chainId: 1 },
    });

    const result = await ComposableCoW.ConditionalOrderCreated.processEvent({
      event: mockEvent,
      mockDb,
    });

    const order = result.entities.ConditionalOrder.getAll()[0]!;
    expect(order.realOwner).toBeUndefined();
  });

  it("should handle all known handler types", async () => {
    const handlers: Array<[string, string]> = [
      ["0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5", "TWAP"],
      ["0xE8212f30c28B4AAb467DF3725C14d6e89C2Eb967", "StopLoss"],
      ["0x412c36e5011cd2517016d243a2dfb37f73a242e7", "StopLoss"],
      ["0x963f411ac754055b611fe464fa4d50772e9b1f9c", "PerpetualSwap"],
      ["0x519ba24e959e33b3b6220ca98bd353d8c2d89920", "PerpetualSwap"],
      ["0x58d2b4b0a29e2d8635b0b47244f3654b1c0f38e9", "GoodAfterTime"],
      ["0xdaf33924925e03c9cc3a10d434016d6cfad0add5", "GoodAfterTime"],
      ["0x812308712a6d1367f437e1c1e4af85c854e1e9f6", "TradeAboveThreshold"],
    ];

    for (const [addr, expectedType] of handlers) {
      expect(getOrderTypeFromHandler(addr, 1)).toBe(expectedType);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// M1: MerkleRootSet Handler
// ═══════════════════════════════════════════════════════════════════════════

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

  it("should handle LOG proof location", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = ComposableCoW.MerkleRootSet.createMockEvent({
      owner: "0x1234567890123456789012345678901234567890",
      root: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      proof: [1n, "0xdeadbeef"], // LOG proof
      mockEventData: { chainId: 1 },
    });

    const result = await ComposableCoW.MerkleRootSet.processEvent({
      event: mockEvent,
      mockDb,
    });

    const root = result.entities.MerkleRoot.getAll()[0]!;
    expect(root.proofLocation).toBe(1);
    expect(root.proofData).toBe("0xdeadbeef");
  });

  it("should use owner-chainId as entity ID", async () => {
    const mockDb = MockDb.createMockDb();
    const owner = "0x1234567890123456789012345678901234567890";

    const mockEvent = ComposableCoW.MerkleRootSet.createMockEvent({
      owner: owner as `0x${string}`,
      root: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      proof: [0n, "0x"],
      mockEventData: { chainId: 42161 },
    });

    const result = await ComposableCoW.MerkleRootSet.processEvent({
      event: mockEvent,
      mockDb,
    });

    const root = result.entities.MerkleRoot.getAll()[0]!;
    expect(root.id).toBe(`${owner.toLowerCase()}-42161`);
  });

  it("should overwrite MerkleRoot for same owner on same chain", async () => {
    const mockDb = MockDb.createMockDb();
    const owner = "0x1234567890123456789012345678901234567890" as const;

    const event1 = ComposableCoW.MerkleRootSet.createMockEvent({
      owner,
      root: "0x1111111111111111111111111111111111111111111111111111111111111111",
      proof: [0n, "0x"],
      mockEventData: { chainId: 1 },
    });

    const db1 = await ComposableCoW.MerkleRootSet.processEvent({
      event: event1,
      mockDb,
    });

    const event2 = ComposableCoW.MerkleRootSet.createMockEvent({
      owner,
      root: "0x2222222222222222222222222222222222222222222222222222222222222222",
      proof: [0n, "0xaa"],
      mockEventData: { chainId: 1 },
    });

    const db2 = await ComposableCoW.MerkleRootSet.processEvent({
      event: event2,
      mockDb: db1,
    });

    const roots = db2.entities.MerkleRoot.getAll();
    expect(roots.length).toBe(1);
    expect(roots[0]!.root).toBe("0x2222222222222222222222222222222222222222222222222222222222222222");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// M2: COWShedBuilt Handler
// ═══════════════════════════════════════════════════════════════════════════

describe("COWShedBuilt Handler", () => {
  it("should create a OwnerMapping entity mapping proxy to EOA", async () => {
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

    const proxies = result.entities.OwnerMapping.getAll();
    expect(proxies.length).toBe(1);
    expect(proxies[0]!.address).toBe(proxyAddress);
    expect(proxies[0]!.owner).toBe(eoaOwner);
  });

  it("should use proxyAddress-chainId as entity ID", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = COWShedFactory.COWShedBuilt.createMockEvent({
      user: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const,
      shed: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
      mockEventData: { chainId: 100 },
    });

    const result = await COWShedFactory.COWShedBuilt.processEvent({
      event: mockEvent,
      mockDb,
    });

    const proxy = result.entities.OwnerMapping.getAll()[0]!;
    expect(proxy.id).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-100");
  });

  it("should retroactively update ConditionalOrders owned by the proxy", async () => {
    const mockDb = MockDb.createMockDb();
    const proxyAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
    const eoaOwner = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
    const twapHandler = "0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5" as const;
    const mockSalt = "0x0000000000000000000000000000000000000000000000000000000000000001";
    const staticInput =
      "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000000e100000000000000000000000000000000000000000000000000000000000000000d26e16c7d99f1e205b3630f43fff7cb142bbdab5ad57196a0c0f0a2f72b734ea1";

    // First: create a ConditionalOrder owned by the proxy (before COWShed is seen)
    const orderEvent = ComposableCoW.ConditionalOrderCreated.createMockEvent({
      owner: proxyAddress,
      params: [twapHandler, mockSalt, staticInput],
      mockEventData: { chainId: 1 },
    });

    const dbWithOrder = await ComposableCoW.ConditionalOrderCreated.processEvent({
      event: orderEvent,
      mockDb,
    });

    // Verify no realOwner yet
    const orderBefore = dbWithOrder.entities.ConditionalOrder.getAll()[0]!;
    expect(orderBefore.realOwner).toBeUndefined();

    // Now: process COWShedBuilt event — should retroactively update the order
    const shedEvent = COWShedFactory.COWShedBuilt.createMockEvent({
      user: eoaOwner,
      shed: proxyAddress,
      mockEventData: { chainId: 1, block: { number: 18000000 } },
    });

    const dbAfterShed = await COWShedFactory.COWShedBuilt.processEvent({
      event: shedEvent,
      mockDb: dbWithOrder,
    });

    // The ConditionalOrder should now have realOwner set
    const orderAfter = dbAfterShed.entities.ConditionalOrder.getAll()[0]!;
    expect(orderAfter.realOwner).toBe(eoaOwner);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// M3: Trade Handler
// ═══════════════════════════════════════════════════════════════════════════

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
    expect(trade.feeAmount).toBe(1000n);
  });

  it("should lowercase token addresses and owner", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = GPv2Settlement.Trade.createMockEvent({
      owner: "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
      sellToken: "0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48",
      buyToken: "0xC02AAA39B223FE8D0A0E5C4F27EAD9083C756CC2",
      sellAmount: 1000000n,
      buyAmount: 500000000000000000n,
      feeAmount: 0n,
      orderUid: "0x" + "ab".repeat(56),
      mockEventData: { chainId: 1 },
    });

    const result = await GPv2Settlement.Trade.processEvent({
      event: mockEvent,
      mockDb,
    });

    const trade = result.entities.Trade.getAll()[0]!;
    expect(trade.owner).toBe("0xabcdef1234567890abcdef1234567890abcdef12");
    expect(trade.sellToken).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(trade.buyToken).toBe("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
  });

  it("should link Trade to ConditionalOrder by owner", async () => {
    const mockDb = MockDb.createMockDb();
    const owner = "0x1234567890123456789012345678901234567890" as const;
    const twapHandler = "0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5" as const;
    const mockSalt = "0x0000000000000000000000000000000000000000000000000000000000000001";
    const staticInput =
      "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000000e100000000000000000000000000000000000000000000000000000000000000000d26e16c7d99f1e205b3630f43fff7cb142bbdab5ad57196a0c0f0a2f72b734ea1";

    // First: create the ConditionalOrder
    const orderEvent = ComposableCoW.ConditionalOrderCreated.createMockEvent({
      owner,
      params: [twapHandler, mockSalt, staticInput],
      mockEventData: { chainId: 1 },
    });

    const dbWithOrder = await ComposableCoW.ConditionalOrderCreated.processEvent({
      event: orderEvent,
      mockDb,
    });

    const orderId = dbWithOrder.entities.ConditionalOrder.getAll()[0]!.id;

    // Then: create a Trade for the same owner
    const tradeEvent = GPv2Settlement.Trade.createMockEvent({
      owner,
      sellToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      buyToken: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      sellAmount: 1000000n,
      buyAmount: 500000000000000000n,
      feeAmount: 0n,
      orderUid: "0x" + "ab".repeat(56),
      mockEventData: { chainId: 1 },
    });

    const dbWithTrade = await GPv2Settlement.Trade.processEvent({
      event: tradeEvent,
      mockDb: dbWithOrder,
    });

    const trade = dbWithTrade.entities.Trade.getAll()[0]!;
    expect(trade.conditionalOrder_id).toBe(orderId);
  });

  it("should not link Trade when no ConditionalOrder exists for owner", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = GPv2Settlement.Trade.createMockEvent({
      owner: "0x9999999999999999999999999999999999999999",
      sellToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      buyToken: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      sellAmount: 1000000n,
      buyAmount: 500000000000000000n,
      feeAmount: 0n,
      orderUid: "0x" + "ab".repeat(56),
      mockEventData: { chainId: 1 },
    });

    const result = await GPv2Settlement.Trade.processEvent({
      event: mockEvent,
      mockDb,
    });

    const trade = result.entities.Trade.getAll()[0]!;
    expect(trade.conditionalOrder_id).toBeUndefined();
  });

  it("should resolve COWShed proxy realOwner on Trade", async () => {
    const mockDb = MockDb.createMockDb();
    const proxyAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
    const eoaOwner = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;

    // Create OwnerMapping
    const shedEvent = COWShedFactory.COWShedBuilt.createMockEvent({
      user: eoaOwner,
      shed: proxyAddress,
      mockEventData: { chainId: 1 },
    });

    const dbWithShed = await COWShedFactory.COWShedBuilt.processEvent({
      event: shedEvent,
      mockDb,
    });

    // Create Trade owned by the proxy
    const tradeEvent = GPv2Settlement.Trade.createMockEvent({
      owner: proxyAddress,
      sellToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      buyToken: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      sellAmount: 1000000n,
      buyAmount: 500000000000000000n,
      feeAmount: 0n,
      orderUid: "0x" + "ab".repeat(56),
      mockEventData: { chainId: 1 },
    });

    const dbWithTrade = await GPv2Settlement.Trade.processEvent({
      event: tradeEvent,
      mockDb: dbWithShed,
    });

    const trade = dbWithTrade.entities.Trade.getAll()[0]!;
    expect(trade.realOwner).toBe(eoaOwner);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Utility: Order Type Resolution
// ═══════════════════════════════════════════════════════════════════════════

describe("Order Type Resolution", () => {
  it("should resolve all known handler addresses", () => {
    expect(getOrderTypeFromHandler("0x6cf1e9ca41f7611def408122793c358a3d11e5a5", 1)).toBe("TWAP");
    expect(getOrderTypeFromHandler("0xe8212f30c28b4aab467df3725c14d6e89c2eb967", 1)).toBe("StopLoss");
    expect(getOrderTypeFromHandler("0x963f411ac754055b611fe464fa4d50772e9b1f9c", 1)).toBe("PerpetualSwap");
    expect(getOrderTypeFromHandler("0x58d2b4b0a29e2d8635b0b47244f3654b1c0f38e9", 1)).toBe("GoodAfterTime");
    expect(getOrderTypeFromHandler("0x812308712a6d1367f437e1c1e4af85c854e1e9f6", 1)).toBe("TradeAboveThreshold");
  });

  it("should resolve alternate deployments", () => {
    expect(getOrderTypeFromHandler("0x412c36e5011cd2517016d243a2dfb37f73a242e7", 1)).toBe("StopLoss");
    expect(getOrderTypeFromHandler("0x519ba24e959e33b3b6220ca98bd353d8c2d89920", 1)).toBe("PerpetualSwap");
    expect(getOrderTypeFromHandler("0xdaf33924925e03c9cc3a10d434016d6cfad0add5", 1)).toBe("GoodAfterTime");
  });

  it("should return Unknown for unrecognized handlers", () => {
    expect(getOrderTypeFromHandler("0x0000000000000000000000000000000000000042", 1)).toBe("Unknown");
  });

  it("should be case-insensitive", () => {
    expect(getOrderTypeFromHandler("0x6CF1E9CA41F7611DEF408122793C358A3D11E5A5", 1)).toBe("TWAP");
  });

  it("should work across all chains", () => {
    for (const chainId of [1, 100, 42161, 8453, 11155111]) {
      expect(getOrderTypeFromHandler("0x6cf1e9ca41f7611def408122793c358a3d11e5a5", chainId)).toBe("TWAP");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Utility: TWAP Decoder
// ═══════════════════════════════════════════════════════════════════════════

describe("TWAP Decoder", () => {
  it("should decode valid TWAP staticInput", () => {
    const staticInput =
      "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000000e100000000000000000000000000000000000000000000000000000000000000000d26e16c7d99f1e205b3630f43fff7cb142bbdab5ad57196a0c0f0a2f72b734ea1" as Hex;

    const decoded = decodeTwapStaticInput(staticInput);

    expect(decoded.sellToken).toMatch(/^0x[a-f0-9]{40}$/);
    expect(decoded.buyToken).toMatch(/^0x[a-f0-9]{40}$/);
    expect(decoded.receiver).toMatch(/^0x[a-f0-9]{40}$/);
    // Verify numeric fields are stringified BigInts
    expect(typeof decoded.partSellAmount).toBe("string");
    expect(typeof decoded.minPartLimit).toBe("string");
    expect(typeof decoded.n).toBe("string");
    expect(typeof decoded.t).toBe("string");
    expect(typeof decoded.span).toBe("string");
  });

  it("should throw on invalid staticInput", () => {
    expect(() => decodeTwapStaticInput("0xdeadbeef" as Hex)).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Utility: decodeStaticInput Router
// ═══════════════════════════════════════════════════════════════════════════

describe("decodeStaticInput Router", () => {
  it("should return null for Unknown order type", () => {
    expect(decodeStaticInput("Unknown", "0x00" as Hex)).toBeNull();
  });

  it("should route TWAP to TWAP decoder", () => {
    const staticInput =
      "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000000e100000000000000000000000000000000000000000000000000000000000000000d26e16c7d99f1e205b3630f43fff7cb142bbdab5ad57196a0c0f0a2f72b734ea1" as Hex;

    const result = decodeStaticInput("TWAP", staticInput) as Record<string, unknown>;
    expect(result.sellToken).toBeDefined();
    expect(result.buyToken).toBeDefined();
    expect(typeof result.n).toBe("string");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Utility: Settle Decoder
// ═══════════════════════════════════════════════════════════════════════════

describe("Settle Decoder", () => {
  it("should return empty Map for non-settle calldata", () => {
    const result = decodeSettleCalldata("0xdeadbeef0000" as Hex);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("should return empty Map for too-short calldata", () => {
    const result = decodeSettleCalldata("0x00" as Hex);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("should not throw on any input", () => {
    expect(() => decodeSettleCalldata("" as Hex)).not.toThrow();
    expect(() => decodeSettleCalldata("0x" as Hex)).not.toThrow();
    expect(() => decodeSettleCalldata("not-hex" as Hex)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Utility: OrderUid Extraction
// ═══════════════════════════════════════════════════════════════════════════

describe("extractOwnerFromOrderUid", () => {
  it("should extract owner from valid orderUid", () => {
    const owner = "0xe7602ca44f83a5e9ba8bd14125ddcb295f3d63bd";
    const digest = "a".repeat(64);
    const validTo = "deadbeef";
    const orderUid = `0x${digest}${owner.slice(2)}${validTo}`;

    const extracted = extractOwnerFromOrderUid(orderUid);
    expect(extracted).toBe(owner);
  });

  it("should return empty string for too-short orderUid", () => {
    expect(extractOwnerFromOrderUid("0x")).toBe("");
    expect(extractOwnerFromOrderUid("short")).toBe("");
    expect(extractOwnerFromOrderUid("0x" + "aa".repeat(30))).toBe("");
  });

  it("should lowercase the extracted owner", () => {
    const digest = "a".repeat(64);
    const ownerUpper = "E7602CA44F83A5E9BA8BD14125DDCB295F3D63BD";
    const validTo = "deadbeef";
    const orderUid = `0x${digest}${ownerUpper}${validTo}`;

    const extracted = extractOwnerFromOrderUid(orderUid);
    expect(extracted).toBe("0x" + ownerUpper.toLowerCase());
  });
});
