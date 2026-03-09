// In-memory caches shared between handlers to avoid DB lookups on every Trade.
// Populated by ComposableCoW and COWShedFactory handlers.
// Trade handler only does DB queries when an owner is in one of these caches.

// owner → most recent ConditionalOrder ID per chain
// Key: "owner-chainId"
export const conditionalOrderOwners = new Map<string, string>();

// proxy address → EOA owner per chain
// Key: "proxyAddress-chainId"
export const cowShedProxies = new Map<string, string>();
