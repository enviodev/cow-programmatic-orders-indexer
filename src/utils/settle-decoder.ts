import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  type Hex,
} from "viem";

// settle(IERC20[] tokens, uint256[] clearingPrices, TradeData[] trades, InteractionData[][3] interactions)
// TradeData: (uint256 sellTokenIndex, uint256 buyTokenIndex, address receiver, uint256 sellAmount,
//             uint256 buyAmount, uint32 validTo, bytes32 appData, uint256 feeAmount,
//             uint256 flags, uint256 executedAmount, bytes signature)
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

// GPv2Order.Data struct for decoding ERC-1271 signatures
// The signature contains: abi.encode(GPv2Order.Data, PayloadStruct)
// PayloadStruct: (bytes32[] proof, ConditionalOrderParams params, bytes offchainInput)
// ConditionalOrderParams: (address handler, bytes32 salt, bytes staticInput)
const ERC1271_SIGNATURE_ABI = [
  {
    type: "tuple",
    name: "order",
    components: [
      { name: "sellToken", type: "address" },
      { name: "buyToken", type: "address" },
      { name: "receiver", type: "address" },
      { name: "sellAmount", type: "uint256" },
      { name: "buyAmount", type: "uint256" },
      { name: "validTo", type: "uint32" },
      { name: "appData", type: "bytes32" },
      { name: "feeAmount", type: "uint256" },
      { name: "kind", type: "bytes32" },
      { name: "partiallyFillable", type: "bool" },
      { name: "sellTokenBalance", type: "bytes32" },
      { name: "buyTokenBalance", type: "bytes32" },
    ],
  },
  {
    type: "tuple",
    name: "payload",
    components: [
      { name: "proof", type: "bytes32[]" },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "handler", type: "address" },
          { name: "salt", type: "bytes32" },
          { name: "staticInput", type: "bytes" },
        ],
      },
      { name: "offchainInput", type: "bytes" },
    ],
  },
] as const;

export interface ConditionalOrderLink {
  handler: string;
  salt: string;
  staticInput: string;
  orderHash: string; // keccak256(abi.encode(params))
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
      // Bit 6-7 of flags: 0=EIP712, 1=EthSign, 2=EIP1271, 3=PreSign
      const sigScheme = Number((trade.flags >> 6n) & 3n);
      if (sigScheme !== 2) continue; // Only ERC-1271

      try {
        const decoded = decodeAbiParameters(
          ERC1271_SIGNATURE_ABI,
          signature as Hex,
        );

        // decoded is: [order, payload]
        // payload has: { proof, params, offchainInput }
        // params has: { handler, salt, staticInput }
        const payload = decoded[1] as {
          proof: readonly Hex[];
          params: { handler: Hex; salt: Hex; staticInput: Hex };
          offchainInput: Hex;
        };
        const params = payload.params;
        const handler = params.handler.toLowerCase();
        const salt = params.salt;
        const staticInput = params.staticInput;

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
          [{ handler: params.handler, salt: params.salt, staticInput: params.staticInput }],
        );
        const orderHash = keccak256(encoded);

        result.set(i, {
          handler,
          salt,
          staticInput,
          orderHash,
        });
      } catch {
        // Not a valid ERC-1271 signature — skip silently
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
