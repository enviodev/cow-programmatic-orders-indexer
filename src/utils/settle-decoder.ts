import {
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  type Hex,
} from "viem";
import { getOrderTypeFromHandler } from "./order-types.js";

// settle(IERC20[] tokens, uint256[] clearingPrices, TradeData[] trades, InteractionData[][3] interactions)
const SETTLE_ABI = [
  {
    name: "settle",
    type: "function",
    inputs: [
      { name: "tokens", type: "address[]" },
      { name: "clearingPrices", type: "uint256[]" },
      {
        name: "trades",
        type: "tuple[]",
        components: [
          { name: "sellTokenIndex", type: "uint256" },
          { name: "buyTokenIndex", type: "uint256" },
          { name: "receiver", type: "address" },
          { name: "sellAmount", type: "uint256" },
          { name: "buyAmount", type: "uint256" },
          { name: "validTo", type: "uint32" },
          { name: "appData", type: "bytes32" },
          { name: "feeAmount", type: "uint256" },
          { name: "flags", type: "uint256" },
          { name: "executedAmount", type: "uint256" },
          { name: "signature", type: "bytes" },
        ],
      },
      {
        name: "interactions",
        type: "tuple[][3]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// Known ComposableCoW handler addresses (used for pattern matching in signatures)
const KNOWN_HANDLERS = [
  "6cf1e9ca41f7611def408122793c358a3d11e5a5", // TWAP
  "e8212f30c28b4aab467df3725c14d6e89c2eb967", // StopLoss
  "412c36e5011cd2517016d243a2dfb37f73a242e7", // StopLoss alt
  "963f411ac754055b611fe464fa4d50772e9b1f9c", // PerpetualSwap
  "519ba24e959e33b3b6220ca98bd353d8c2d89920", // PerpetualSwap alt
  "58d2b4b0a29e2d8635b0b47244f3654b1c0f38e9", // GoodAfterTime
  "daf33924925e03c9cc3a10d434016d6cfad0add5", // GoodAfterTime alt
  "812308712a6d1367f437e1c1e4af85c854e1e9f6", // TradeAboveThreshold
];

export interface ConditionalOrderLink {
  handler: string;
  salt: string;
  staticInput: string;
  orderHash: string; // keccak256(abi.encode(params))
}

/**
 * Extract ConditionalOrderParams from an ERC-1271 signature by finding the
 * handler address pattern and reading the ABI-encoded params from there.
 *
 * The GPv2 ERC-1271 signature format is:
 *   [20 bytes signer] [abi.encode(GPv2Order.Data, ComposableCoW.PayloadStruct)]
 *
 * The inner encoding uses Solidity's struct ABI encoding which viem cannot
 * decode directly due to alignment issues. Instead, we find the known handler
 * address in the signature bytes and extract the ConditionalOrderParams
 * (handler, salt, staticInput) from the surrounding ABI-encoded tuple.
 */
function extractParamsFromSignature(signature: string): ConditionalOrderLink | null {
  // Strip "0x" prefix and 20-byte signer for searching
  const sigHex = signature.slice(42).toLowerCase();

  for (const handlerAddr of KNOWN_HANDLERS) {
    // Find handler address with 12-byte zero-padding (ABI-encoded address)
    const pattern = "000000000000000000000000" + handlerAddr;
    const handlerFieldPos = sigHex.indexOf(pattern);
    if (handlerFieldPos < 0) continue;

    // ConditionalOrderParams tuple: (address handler, bytes32 salt, bytes staticInput)
    // In ABI encoding:
    //   word 0: handler (address, padded to 32 bytes) — found
    //   word 1: salt (bytes32)
    //   word 2: offset to staticInput data (relative to tuple start)
    //   [at offset]: length of staticInput
    //   [at offset+32]: staticInput bytes

    // Extract salt (next 32-byte word = 64 hex chars)
    const saltPos = handlerFieldPos + 64;
    if (saltPos + 64 > sigHex.length) continue;
    const salt = "0x" + sigHex.slice(saltPos, saltPos + 64);

    // Extract staticInput offset (next 32-byte word)
    const offsetPos = saltPos + 64;
    if (offsetPos + 64 > sigHex.length) continue;
    const siOffset = parseInt(sigHex.slice(offsetPos, offsetPos + 64), 16);

    // staticInput data location: tuple start + offset
    // tuple start = handlerFieldPos (in hex chars)
    const tupleStartByte = handlerFieldPos / 2;
    const siDataByte = tupleStartByte + siOffset;
    const siDataHexPos = siDataByte * 2;

    // Read length word
    if (siDataHexPos + 64 > sigHex.length) continue;
    const siLength = parseInt(sigHex.slice(siDataHexPos, siDataHexPos + 64), 16);

    // Read staticInput bytes
    const siStart = siDataHexPos + 64;
    if (siStart + siLength * 2 > sigHex.length) continue;
    const staticInput = ("0x" + sigHex.slice(siStart, siStart + siLength * 2)) as Hex;

    const handler = ("0x" + handlerAddr) as Hex;

    // Compute order hash: keccak256(abi.encode(ConditionalOrderParams))
    const encoded = encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "handler", type: "address" },
            { name: "salt", type: "bytes32" },
            { name: "staticInput", type: "bytes" },
          ],
        },
      ],
      [{ handler, salt: salt as Hex, staticInput }],
    );
    const orderHash = keccak256(encoded);

    return {
      handler: handler.toLowerCase(),
      salt,
      staticInput,
      orderHash,
    };
  }

  return null;
}

/**
 * Attempt to decode ERC-1271 signatures from settle() calldata
 * and extract ConditionalOrderParams for each trade.
 *
 * Returns a map: tradeIndex → ConditionalOrderLink
 */
export function decodeSettleCalldata(
  input: Hex,
): Map<number, ConditionalOrderLink> {
  const result = new Map<number, ConditionalOrderLink>();

  try {
    const decoded = decodeFunctionData({
      abi: SETTLE_ABI,
      data: input,
    });

    if (decoded.functionName !== "settle") return result;

    const trades = decoded.args[2]; // trades array

    for (let i = 0; i < trades.length; i++) {
      const trade = trades[i]!;
      const signature = trade.signature;

      // ERC-1271 signatures are typically > 100 bytes (contain GPv2Order + PayloadStruct)
      // ECDSA signatures are 65 bytes. Pre-sign signatures are 20 bytes.
      if (!signature || signature.length < 200) continue;

      // Check flags to determine signature scheme
      // GPv2Trade.extractFlags: signingScheme = Scheme(uint8((flags >> 5) & 0x3))
      // Bit 5-6 of flags: 0=EIP712, 1=EthSign, 2=EIP1271, 3=PreSign
      const sigScheme = Number((trade.flags >> 5n) & 3n);
      if (sigScheme !== 2) continue; // Only ERC-1271

      const link = extractParamsFromSignature(signature);
      if (link) {
        result.set(i, link);
      }
    }
  } catch {
    // Not a settle() call or malformed calldata — skip
  }

  return result;
}

/**
 * Extract the owner address from an orderUid.
 * orderUid = 32 bytes order digest + 20 bytes owner + 4 bytes validTo
 */
export function extractOwnerFromOrderUid(orderUid: string): string {
  // orderUid is hex-encoded, so 56 bytes = 112 hex chars + "0x" prefix = 114 chars
  // owner starts at byte 32 (char 66) and is 20 bytes (40 chars)
  if (orderUid.length < 114) return "";
  return "0x" + orderUid.slice(66, 106).toLowerCase();
}
