import { ComposableCoW } from "generated";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { getOrderTypeFromHandler } from "../utils/order-types.js";
import { decodeStaticInput } from "../decoders/index.js";

// ─── ConditionalOrderCreated ────────────────────────────────────────────────

ComposableCoW.ConditionalOrderCreated.handler(async ({ event, context }) => {
  const owner = event.params.owner.toLowerCase();
  // params is a tuple: [handler, salt, staticInput]
  const [handlerAddr, salt, staticInput] = event.params.params;
  const handler = handlerAddr.toLowerCase();

  // Compute deterministic order hash: keccak256(abi.encode(params))
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
    [{ handler: handlerAddr, salt: salt as Hex, staticInput: staticInput as Hex }],
  );
  const hash = keccak256(encoded);

  const chainId = event.chainId;
  const orderType = getOrderTypeFromHandler(handler, chainId);
  const orderId = `${hash}-${chainId}`;

  // Decode staticInput based on handler type
  let decodedParams: object | undefined = undefined;
  let decodeError: string | undefined = undefined;

  if (orderType !== "Unknown") {
    try {
      const decoded = decodeStaticInput(orderType, staticInput as Hex);
      if (decoded) {
        decodedParams = JSON.parse(
          JSON.stringify(decoded, (_key, value) =>
            typeof value === "bigint" ? value.toString() : value,
          ),
        );
      }
    } catch (err) {
      decodeError = "invalid_static_input";
      context.log.warn(
        `Decode failed for order ${orderId} type=${orderType}: ${err}`,
      );
    }
  }

  // M2: Resolve COWShed proxy owner if available
  let realOwner: string | undefined = undefined;
  const proxy = await context.COWShedProxy.get(`${owner}-${chainId}`);
  if (proxy) {
    realOwner = proxy.eoaOwner;
  }

  context.ConditionalOrder.set({
    id: orderId,
    chainId,
    owner,
    handler,
    salt,
    staticInput,
    hash,
    orderType,
    status: "Active",
    blockNumber: event.block.number,
    blockTimestamp: BigInt(event.block.timestamp),
    transactionHash: event.transaction.hash,
    createdBy: event.transaction.from?.toLowerCase() ?? "",
    decodedParams,
    decodeError,
    realOwner,
  });
});

// ─── MerkleRootSet ──────────────────────────────────────────────────────────

ComposableCoW.MerkleRootSet.handler(async ({ event, context }) => {
  const owner = event.params.owner.toLowerCase();
  const chainId = event.chainId;
  const merkleId = `${owner}-${chainId}`;

  // proof is a tuple: [location, data]
  const [location, data] = event.params.proof;

  context.MerkleRoot.set({
    id: merkleId,
    chainId,
    owner,
    root: event.params.root,
    proofLocation: Number(location),
    proofData: data,
    blockNumber: event.block.number,
    blockTimestamp: BigInt(event.block.timestamp),
    transactionHash: event.transaction.hash,
  });

  // If proof location is LOG (1), the proof data contains encoded conditional orders.
  if (Number(location) === 1) {
    context.log.info(
      `MerkleRootSet with LOG proof for owner=${owner} on chain=${chainId}, root=${event.params.root}`,
    );
  }
});
