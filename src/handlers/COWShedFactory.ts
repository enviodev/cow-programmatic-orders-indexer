/**
 * COWShedBuilt handler — maps proxy address → EOA owner in OwnerMapping.
 * Ported 1:1 from the upstream ponder indexer's cowshed.ts.
 */

import { indexer } from "envio";

indexer.onEvent(
  { contract: "COWShedFactory", event: "COWShedBuilt" },
  async ({ event, context }) => {
    const { user, shed } = event.params;
    const chainId = event.chainId;
    const proxyAddress = shed.toLowerCase();

    context.Transaction.set({
      id: `${chainId}_${event.transaction.hash}`,
      hash: event.transaction.hash,
      chainId,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: BigInt(event.block.timestamp),
    });

    // Insert-only (upstream onConflictDoNothing).
    const id = `${chainId}_${proxyAddress}`;
    const existing = await context.OwnerMapping.get(id);
    if (!existing) {
      context.OwnerMapping.set({
        id,
        address: proxyAddress,
        chainId,
        owner: user.toLowerCase(),
        addressType: "cowshed_proxy",
        txHash: event.transaction.hash,
        blockNumber: BigInt(event.block.number),
        resolutionDepth: 0,
      });
    }
  },
);
