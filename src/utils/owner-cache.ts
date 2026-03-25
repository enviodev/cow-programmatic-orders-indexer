// In-memory caches shared between handlers to avoid DB lookups on every Trade.
// Populated by ComposableCoW, COWShedFactory, and GPv2Settlement handlers.
// Trade handler only does DB queries when an owner is in one of these caches.

// owner → most recent ConditionalOrder ID per chain
// Key: "owner-chainId"
export const conditionalOrderOwners = new Map<string, string>();

// proxy/adapter address → resolved EOA owner per chain
// Covers both COWShed proxies and Aave V3 flash loan adapters.
// Key: "address-chainId"
export const resolvedOwners = new Map<string, string>();

// Addresses already checked and confirmed NOT to be Aave adapters.
// Prevents repeated RPC calls for the same non-adapter contracts.
// Key: "address-chainId"
export const checkedNonAdapters = new Set<string>();
