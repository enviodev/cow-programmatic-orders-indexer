import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";
import { getOrderTypeFromHandler, isNonDeterministic, NON_DETERMINISTIC_TYPES } from "./utils/order-types.js";
import { decodeStaticInput } from "./decoders/index.js";
import { decodeTwapStaticInput } from "./decoders/twap.js";
import { decodeEip1271Signature } from "./decoders/erc1271-signature.js";
import { decodeValidToFromOrderUid, detectFlashLoanOrderType } from "./decoders/flash-loan-order.js";
import { computeOrderUid, KIND_SELL, BALANCE_ERC20 } from "./helpers/orderUid.js";
import { precomputeOrderUids } from "./helpers/uidPrecompute.js";
import { toDiscreteStatus } from "./helpers/orderbook/types.js";
import type { Hex } from "viem";

// Real TWAP staticInput from mainnet block 17891788
const REAL_TWAP_STATIC_INPUT =
  "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000000e100000000000000000000000000000000000000000000000000000000000000000d26e16c7d99f1e205b3630f43fff7cb142bbdab5ad57196a0c0f0a2f72b734ea";

const TWAP_HANDLER = "0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5" as const;
const MOCK_SALT = "0x0000000000000000000000000000000000000000000000000000000000000001";

// ═══════════════════════════════════════════════════════════════════════════
// ConditionalOrderCreated Handler
// ═══════════════════════════════════════════════════════════════════════════

describe("ConditionalOrderCreated Handler", () => {
  it("should create a ConditionalOrderGenerator from a TWAP event", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        1: {
          simulate: [
            {
              contract: "ComposableCoW",
              event: "ConditionalOrderCreated",
              params: {
                owner: "0x1234567890123456789012345678901234567890",
                params: {
                  handler: TWAP_HANDLER,
                  salt: MOCK_SALT,
                  staticInput: REAL_TWAP_STATIC_INPUT,
                },
              },
              block: { number: 17883050, timestamp: 1692000000 },
              transaction: {
                hash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
              },
            },
          ],
        },
      },
    });

    const generators = await indexer.ConditionalOrderGenerator.getAll();
    expect(generators.length).toBe(1);

    const gen = generators[0]!;
    expect(gen.orderType).toBe("TWAP");
    expect(gen.status).toBe("Active");
    expect(gen.chainId).toBe(1);
    expect(gen.handler).toBe(TWAP_HANDLER.toLowerCase());
    expect(gen.decodedParams).toBeDefined();
    // Deterministic type → no OwnerBackfill drain needed
    expect(gen.historyBackfilled).toBe(true);
    // Precompute ran → all candidate UIDs known
    expect(gen.allCandidatesKnown).toBe(true);

    // Transaction row upserted
    const tx = await indexer.Transaction.get(
      "1_0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    );
    expect(tx).toBeDefined();
    expect(tx!.chainId).toBe(1);
  }, 30_000);

  it("should precompute discrete/candidate orders for TWAP (n=5 parts)", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        1: {
          simulate: [
            {
              contract: "ComposableCoW",
              event: "ConditionalOrderCreated",
              params: {
                owner: "0x1234567890123456789012345678901234567890",
                params: {
                  handler: TWAP_HANDLER,
                  salt: MOCK_SALT,
                  staticInput: REAL_TWAP_STATIC_INPUT,
                },
              },
              block: { number: 17883050, timestamp: 1692000000 },
            },
          ],
        },
      },
    });

    // The real TWAP staticInput has n=5 parts. Each part lands either in
    // DiscreteOrder (known to the orderbook) or CandidateDiscreteOrder.
    const discrete = await indexer.DiscreteOrder.getAll();
    const candidates = await indexer.CandidateDiscreteOrder.getAll();
    expect(discrete.length + candidates.length).toBe(5);

    // possibleValidAfterTimestamp is t0 + partIndex * t for each part
    for (const c of candidates) {
      expect(c.chainId).toBe(1);
      expect(c.orderUid).toMatch(/^0x[a-f0-9]{112}$/);
    }
  }, 30_000);

  it("should handle unknown handler addresses gracefully", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        1: {
          simulate: [
            {
              contract: "ComposableCoW",
              event: "ConditionalOrderCreated",
              params: {
                owner: "0x1234567890123456789012345678901234567890",
                params: {
                  handler: "0x0000000000000000000000000000000000000042",
                  salt: MOCK_SALT,
                  staticInput: "0x00",
                },
              },
            },
          ],
        },
      },
    });

    const generators = await indexer.ConditionalOrderGenerator.getAll();
    expect(generators.length).toBe(1);
    expect(generators[0]!.orderType).toBe("Unknown");
    expect(generators[0]!.decodedParams).toBeUndefined();
    expect(generators[0]!.decodeError).toBeUndefined();
    // Unknown is non-deterministic but was created "live" or not — historical
    // creation of a non-deterministic type leaves historyBackfilled=false.
    expect(generators[0]!.allCandidatesKnown).toBe(false);
  });

  it("should compute the params hash and expose scheduling defaults", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        1: {
          simulate: [
            {
              contract: "ComposableCoW",
              event: "ConditionalOrderCreated",
              params: {
                owner: "0x1234567890123456789012345678901234567890",
                params: {
                  handler: TWAP_HANDLER,
                  salt: MOCK_SALT,
                  staticInput: REAL_TWAP_STATIC_INPUT,
                },
              },
              block: { number: 17883050, timestamp: 1692000000 },
            },
          ],
        },
      },
    });

    const gen = (await indexer.ConditionalOrderGenerator.getAll())[0]!;
    // id is chainId_blockNumber_logIndex
    expect(gen.id).toMatch(/^1_\d+_\d+$/);
    // Hash is keccak256 of the abi-encoded params tuple
    expect(gen.hash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(gen.nextCheckBlock).toBe(17883050n);
    expect(gen.consecutiveTryNextBlock).toBe(0);
  }, 30_000);

  it("should set decodeError for malformed staticInput", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        1: {
          simulate: [
            {
              contract: "ComposableCoW",
              event: "ConditionalOrderCreated",
              params: {
                owner: "0x1234567890123456789012345678901234567890",
                params: {
                  handler: TWAP_HANDLER,
                  salt: MOCK_SALT,
                  staticInput: "0xdeadbeef",
                },
              },
            },
          ],
        },
      },
    });

    const gen = (await indexer.ConditionalOrderGenerator.getAll())[0]!;
    expect(gen.orderType).toBe("TWAP");
    expect(gen.decodedParams).toBeUndefined();
    expect(gen.decodeError).toBe("invalid_static_input");
  });

  it("should lowercase owner and handler addresses", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        1: {
          simulate: [
            {
              contract: "ComposableCoW",
              event: "ConditionalOrderCreated",
              params: {
                owner: "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
                params: {
                  handler: TWAP_HANDLER,
                  salt: MOCK_SALT,
                  staticInput: REAL_TWAP_STATIC_INPUT,
                },
              },
            },
          ],
        },
      },
    });

    const gen = (await indexer.ConditionalOrderGenerator.getAll())[0]!;
    expect(gen.owner).toBe("0xabcdef1234567890abcdef1234567890abcdef12");
    expect(gen.handler).toBe(TWAP_HANDLER.toLowerCase());
  }, 30_000);

  it("should resolve owner via OwnerMapping when a COWShed proxy exists", async () => {
    const indexer = createTestIndexer();
    const proxyAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const eoaOwner = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    await indexer.process({
      chains: {
        1: {
          simulate: [
            {
              contract: "COWShedFactory",
              event: "COWShedBuilt",
              params: {
                user: eoaOwner as `0x${string}`,
                shed: proxyAddress as `0x${string}`,
              },
              block: { number: 17883050 },
            },
            {
              contract: "ComposableCoW",
              event: "ConditionalOrderCreated",
              params: {
                owner: proxyAddress as `0x${string}`,
                params: {
                  handler: TWAP_HANDLER,
                  salt: MOCK_SALT,
                  staticInput: REAL_TWAP_STATIC_INPUT,
                },
              },
              block: { number: 17883051 },
            },
          ],
        },
      },
    });

    const gen = (await indexer.ConditionalOrderGenerator.getAll())[0]!;
    expect(gen.resolvedOwner).toBe(eoaOwner);
    expect(gen.ownerAddressType).toBe("cowshed_proxy");
  }, 30_000);

  it("should fall back resolvedOwner to owner when no mapping exists", async () => {
    const indexer = createTestIndexer();
    const owner = "0x1234567890123456789012345678901234567890";

    await indexer.process({
      chains: {
        1: {
          simulate: [
            {
              contract: "ComposableCoW",
              event: "ConditionalOrderCreated",
              params: {
                owner: owner as `0x${string}`,
                params: {
                  handler: TWAP_HANDLER,
                  salt: MOCK_SALT,
                  staticInput: REAL_TWAP_STATIC_INPUT,
                },
              },
            },
          ],
        },
      },
    });

    const gen = (await indexer.ConditionalOrderGenerator.getAll())[0]!;
    expect(gen.resolvedOwner).toBe(owner);
    expect(gen.ownerAddressType).toBeUndefined();
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// COWShedBuilt Handler
// ═══════════════════════════════════════════════════════════════════════════

describe("COWShedBuilt Handler", () => {
  it("should create an OwnerMapping entity mapping proxy to EOA", async () => {
    const indexer = createTestIndexer();

    const proxyAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
    const eoaOwner = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;

    await indexer.process({
      chains: {
        1: {
          simulate: [
            {
              contract: "COWShedFactory",
              event: "COWShedBuilt",
              params: { user: eoaOwner, shed: proxyAddress },
              block: { number: 18000000 },
              transaction: {
                hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
              },
            },
          ],
        },
      },
    });

    const mappings = await indexer.OwnerMapping.getAll();
    expect(mappings.length).toBe(1);
    expect(mappings[0]!.address).toBe(proxyAddress);
    expect(mappings[0]!.owner).toBe(eoaOwner);
    expect(mappings[0]!.addressType).toBe("cowshed_proxy");
    expect(mappings[0]!.resolutionDepth).toBe(0);
  });

  it("should use chainId_proxyAddress as entity ID", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        100: {
          simulate: [
            {
              contract: "COWShedFactory",
              event: "COWShedBuilt",
              params: {
                user: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                shed: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              },
            },
          ],
        },
      },
    });

    const mapping = (await indexer.OwnerMapping.getAll())[0]!;
    expect(mapping.id).toBe("100_0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Settlement Handler
// ═══════════════════════════════════════════════════════════════════════════

describe("Settlement Handler", () => {
  it("should process a Settlement event without crashing (no adapter trades)", async () => {
    const indexer = createTestIndexer();

    // The scan effect fetches the (nonexistent) receipt and degrades to [].
    await indexer.process({
      chains: {
        1: {
          simulate: [
            {
              contract: "GPv2Settlement",
              event: "Settlement",
              params: { solver: "0x9da8B48441583a2b93e2eF8213aAD0EC0b392C69" },
              block: { number: 23812800 },
              transaction: {
                hash: "0x3333333333333333333333333333333333333333333333333333333333333333",
              },
            },
          ],
        },
      },
    });

    const orders = await indexer.FlashLoanOrder.getAll();
    expect(orders.length).toBe(0);

    // Trade logs come from HyperSync by (block, settlement, topic): the fake
    // tx matches none, so the scan succeeds empty — nothing deferred.
    const pending = await indexer.PendingSettlementScan.getAll();
    expect(pending.length).toBe(0);
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Utility: Order Type Resolution
// ═══════════════════════════════════════════════════════════════════════════

describe("Order Type Resolution", () => {
  it("should resolve the five chain-agnostic handlers on mainnet and gnosis", () => {
    for (const chainId of [1, 100]) {
      expect(getOrderTypeFromHandler("0x6cf1e9ca41f7611def408122793c358a3d11e5a5", chainId)).toBe("TWAP");
      expect(getOrderTypeFromHandler("0x412c36e5011cd2517016d243a2dfb37f73a242e7", chainId)).toBe("StopLoss");
      expect(getOrderTypeFromHandler("0x519ba24e959e33b3b6220ca98bd353d8c2d89920", chainId)).toBe("PerpetualSwap");
      expect(getOrderTypeFromHandler("0xdaf33924925e03c9cc3a10d434016d6cfad0add5", chainId)).toBe("GoodAfterTime");
      expect(getOrderTypeFromHandler("0x812308712a6d1367f437e1c1e4af85c854e1e9f6", chainId)).toBe("TradeAboveThreshold");
    }
  });

  it("should resolve mainnet-only handlers", () => {
    expect(getOrderTypeFromHandler("0xd506fe0b3ddf9e685c16e000514a835d3a511b26", 1)).toBe("SwapOrderHandler");
    expect(getOrderTypeFromHandler("0x816e90dc85bf016455017a76bc09cc0451eeb308", 1)).toBe("ERC4626CowSwapFeeBurner");
    expect(getOrderTypeFromHandler("0xc0fc3ddfec95ca45a0d2393f518d3ea1ccf44f8b", 1)).toBe("CurveCowSwapBurner");
    expect(getOrderTypeFromHandler("0x9958317b80ee5f10457017d54c2484d722059157", 1)).toBe("BalancerCowSwapFeeBurner");
    expect(getOrderTypeFromHandler("0x0e800d8d2e8b4694610aedc385aa6d763492b106", 1)).toBe("BalancerCowSwapFeeBurner");
    // Not deployed on gnosis
    expect(getOrderTypeFromHandler("0xd506fe0b3ddf9e685c16e000514a835d3a511b26", 100)).toBe("Unknown");
  });

  it("should resolve gnosis-only handlers", () => {
    expect(getOrderTypeFromHandler("0x43866c5602b0e3b3272424396e88b849796dc608", 100)).toBe("CirclesBackingOrder");
    expect(getOrderTypeFromHandler("0x7a77934d32d78bfe8dc1e23415b5679960a1c610", 100)).toBe("SwapOrderHandler");
    expect(getOrderTypeFromHandler("0x5915dea04ce390f0f44ca0806f7c6dd99ce2f941", 100)).toBe("ERC4626CowSwapFeeBurner");
    expect(getOrderTypeFromHandler("0x254f3a2974b97dc2e675f6115c845567c55f83b0", 100)).toBe("BalancerCowSwapFeeBurner");
    expect(getOrderTypeFromHandler("0xb148f40fff05b5ce6b22752cf8e454b556f7a851", 100)).toBe("CowAmmConstantProduct");
    // Not deployed on mainnet
    expect(getOrderTypeFromHandler("0x43866c5602b0e3b3272424396e88b849796dc608", 1)).toBe("Unknown");
  });

  it("should return Unknown for unrecognized handlers and chains", () => {
    expect(getOrderTypeFromHandler("0x0000000000000000000000000000000000000042", 1)).toBe("Unknown");
    expect(getOrderTypeFromHandler("0x6cf1e9ca41f7611def408122793c358a3d11e5a5", 42161)).toBe("Unknown");
  });

  it("should be case-insensitive", () => {
    expect(getOrderTypeFromHandler("0x6CF1E9CA41F7611DEF408122793C358A3D11E5A5", 1)).toBe("TWAP");
  });

  it("should classify deterministic vs non-deterministic types", () => {
    expect(isNonDeterministic("TWAP")).toBe(false);
    expect(isNonDeterministic("StopLoss")).toBe(false);
    expect(isNonDeterministic("CirclesBackingOrder")).toBe(false);
    expect(isNonDeterministic("PerpetualSwap")).toBe(true);
    expect(isNonDeterministic("GoodAfterTime")).toBe(true);
    expect(isNonDeterministic("Unknown")).toBe(true);
    expect(NON_DETERMINISTIC_TYPES).not.toContain("TWAP");
    expect(NON_DETERMINISTIC_TYPES).toContain("SwapOrderHandler");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Utility: Decoders
// ═══════════════════════════════════════════════════════════════════════════

describe("TWAP Decoder", () => {
  it("should decode valid TWAP staticInput (bigint fields)", () => {
    const decoded = decodeTwapStaticInput(REAL_TWAP_STATIC_INPUT as Hex);

    expect(decoded.sellToken).toMatch(/^0x[a-f0-9]{40}$/);
    expect(decoded.buyToken).toMatch(/^0x[a-f0-9]{40}$/);
    expect(decoded.receiver).toMatch(/^0x[a-f0-9]{40}$/);
    // Upstream decoders return raw bigints; the handler stringifies them.
    expect(typeof decoded.partSellAmount).toBe("bigint");
    expect(typeof decoded.minPartLimit).toBe("bigint");
    expect(decoded.n).toBe(5n);
    expect(decoded.t).toBe(3600n);
    expect(decoded.span).toBe(0n);
  });

  it("should throw on invalid staticInput", () => {
    expect(() => decodeTwapStaticInput("0xdeadbeef" as Hex)).toThrow();
  });
});

describe("decodeStaticInput Router", () => {
  it("should return null for Unknown order type", () => {
    expect(decodeStaticInput("Unknown", "0x00" as Hex)).toBeNull();
  });

  it("should return null for types without a staticInput decoder", () => {
    expect(decodeStaticInput("CurveCowSwapBurner", "0x00" as Hex)).toBeNull();
    expect(decodeStaticInput("CowAmmConstantProduct", "0x00" as Hex)).toBeNull();
  });

  it("should route TWAP to the TWAP decoder", () => {
    const result = decodeStaticInput("TWAP", REAL_TWAP_STATIC_INPUT as Hex) as Record<string, unknown>;
    expect(result.sellToken).toBeDefined();
    expect(result.buyToken).toBeDefined();
    expect(typeof result.n).toBe("bigint");
  });
});

describe("Flash-loan decoders", () => {
  it("should decode validTo from the trailing 4 bytes of an order UID", () => {
    const digest = "a".repeat(64);
    const owner = "b".repeat(40);
    const uid = `0x${digest}${owner}deadbeef` as `0x${string}`;
    expect(decodeValidToFromOrderUid(uid)).toBe(0xdeadbeef);
  });

  it("should detect adapter type from EIP-1167 bytecode", () => {
    const clone = (impl: string) =>
      `0x363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3` as `0x${string}`;
    expect(detectFlashLoanOrderType(clone("ac27f3f86e78b14721d07c4f9ce999285f9aaa06"))).toBe("RepayWithCollateral");
    expect(detectFlashLoanOrderType(clone("029d584e847373b6373b01dfad1a0c9bfb916382"))).toBe("CollateralSwap");
    expect(detectFlashLoanOrderType(clone("73e7af13ef172f13d8fefebfd90c7a6530096344"))).toBe("DebtSwap");
    expect(detectFlashLoanOrderType(clone("0000000000000000000000000000000000000000"))).toBeNull();
    expect(detectFlashLoanOrderType("0x6080604052" as `0x${string}`)).toBeNull();
  });
});

describe("EIP-1271 signature decoder", () => {
  it("should return null for undecodable signatures", () => {
    expect(decodeEip1271Signature("0x" as Hex)).toBeNull();
    expect(decodeEip1271Signature("0xdeadbeef" as Hex)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Utility: Order UID computation + precompute
// ═══════════════════════════════════════════════════════════════════════════

describe("computeOrderUid", () => {
  it("should produce a 56-byte UID ending in owner+validTo", () => {
    const owner = "0xe7602ca44f83a5e9ba8bd14125ddcb295f3d63bd" as Hex;
    const uid = computeOrderUid(1, {
      sellToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      buyToken: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      receiver: owner,
      sellAmount: 1000000n,
      buyAmount: 1n,
      validTo: 0xdeadbeef,
      appData: ("0x" + "00".repeat(32)) as Hex,
      feeAmount: 0n,
      kind: KIND_SELL,
      partiallyFillable: false,
      sellTokenBalance: BALANCE_ERC20,
      buyTokenBalance: BALANCE_ERC20,
    }, owner);

    expect(uid).toMatch(/^0x[a-fA-F0-9]{112}$/);
    expect(uid.toLowerCase().endsWith(`${owner.slice(2)}deadbeef`)).toBe(true);
  });

  it("should be deterministic and chain-sensitive", () => {
    const owner = "0xe7602ca44f83a5e9ba8bd14125ddcb295f3d63bd" as Hex;
    const order = {
      sellToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Hex,
      buyToken: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" as Hex,
      receiver: owner,
      sellAmount: 1000000n,
      buyAmount: 1n,
      validTo: 1700000000,
      appData: ("0x" + "00".repeat(32)) as Hex,
      feeAmount: 0n,
      kind: KIND_SELL,
      partiallyFillable: false,
      sellTokenBalance: BALANCE_ERC20,
      buyTokenBalance: BALANCE_ERC20,
    };
    expect(computeOrderUid(1, order, owner)).toBe(computeOrderUid(1, order, owner));
    expect(computeOrderUid(1, order, owner)).not.toBe(computeOrderUid(100, order, owner));
  });
});

describe("precomputeOrderUids", () => {
  const twapParams = {
    sellToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    buyToken: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    receiver: "0x0000000000000000000000000000000000000000",
    partSellAmount: "1000000",
    minPartLimit: "1",
    t0: "1692000000",
    n: "5",
    t: "3600",
    span: "0",
    appData: "0x" + "00".repeat(32),
  };
  const owner = "0xe7602ca44f83a5e9ba8bd14125ddcb295f3d63bd" as Hex;

  it("should enumerate all TWAP part UIDs with contract validTo math", () => {
    const orders = precomputeOrderUids(1, owner, "TWAP", twapParams, 1692000000n);
    expect(orders).not.toBeNull();
    expect(orders!.length).toBe(5);
    // span=0: validTo_i = t0 + (i+1)*t - 1
    for (let i = 0; i < 5; i++) {
      expect(orders![i]!.validTo).toBe(1692000000 + (i + 1) * 3600 - 1);
      expect(orders![i]!.possibleValidAfterTimestamp).toBe(1692000000 + i * 3600);
      expect(orders![i]!.orderUid).toMatch(/^0x[a-f0-9]{112}$/);
    }
  });

  it("should return null for non-deterministic types", () => {
    expect(precomputeOrderUids(1, owner, "PerpetualSwap", twapParams, 0n)).toBeNull();
    expect(precomputeOrderUids(1, owner, "SwapOrderHandler", twapParams, 0n)).toBeNull();
  });

  it("should return null when params are missing", () => {
    expect(precomputeOrderUids(1, owner, "TWAP", null, 0n)).toBeNull();
    expect(precomputeOrderUids(1, owner, "TWAP", { n: "5" }, 0n)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Utility: status mapping
// ═══════════════════════════════════════════════════════════════════════════

describe("toDiscreteStatus", () => {
  it("should map API statuses to the capitalized enum", () => {
    expect(toDiscreteStatus("open")).toBe("Open");
    expect(toDiscreteStatus("fulfilled")).toBe("Fulfilled");
    expect(toDiscreteStatus("unfilled")).toBe("Unfilled");
    expect(toDiscreteStatus("expired")).toBe("Expired");
    expect(toDiscreteStatus("cancelled")).toBe("Cancelled");
  });
});
