import { COWShedFactory } from "generated";
import { resolvedOwners } from "../utils/owner-cache.js";

// ─── COWShedBuilt ───────────────────────────────────────────────────────────
// Emitted when a COWShed proxy is deployed for an EOA.
// Maps: proxy address → EOA owner in OwnerMapping.

COWShedFactory.COWShedBuilt.handler(async ({ event, context }) => {
  const proxyAddress = event.params.shed.toLowerCase();
  const eoaOwner = event.params.user.toLowerCase();
  const chainId = event.chainId;

  context.OwnerMapping.set({
    id: `${proxyAddress}-${chainId}`,
    address: proxyAddress,
    owner: eoaOwner,
    chainId,
    addressType: "CowShedProxy",
    resolutionDepth: 0, // direct mapping, no hops
    blockNumber: event.block.number,
    transactionHash: event.transaction.hash,
  });

  // Cache so Trade handler can skip DB lookups for non-proxy owners
  resolvedOwners.set(`${proxyAddress}-${chainId}`, eoaOwner);

  // Retroactively update any ConditionalOrders owned by this proxy
  // that were indexed before the proxy deployment was seen.
  // This handles the case where ComposableCoW events arrive before
  // the COWShedBuilt event (cross-contract ordering).
  const existingOrders = await context.ConditionalOrder.getWhere({
    owner: { _eq: proxyAddress },
  });

  for (const order of existingOrders) {
    context.ConditionalOrder.set({
      ...order,
      realOwner: eoaOwner,
    });
  }
});
