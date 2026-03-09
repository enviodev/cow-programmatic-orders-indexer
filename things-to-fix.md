# Things to Fix

## Effects / OrderBook API

1. **Schema types are hacky** — Using `unknown` output schema via `rescript-schema/src/S.js` import. Should properly type the CoW API response with named fields (uid, status, sellToken, etc.)

2. **Wrong trigger location** — OrderBook API fetch only fires from Trade handler. Should ALSO trigger from `ConditionalOrderCreated` handler — the whole point is visibility *before* settlement.

3. **No response typing** — `apiOrder.uid`, `apiOrder.status` etc. are untyped `any` casts. Define proper response schema.

4. **Rate limiting is a guess** — `5 calls/second` is arbitrary. Check CoW API docs for actual limits.

5. **Effect import path** — Importing from `rescript-schema/src/S.js` is fragile. Check if envio v3 stable has a better pattern or re-exports the schema helpers.

## ERC-1271 Trade Linking

6. **No trades linked yet** — Trade handler has the ERC-1271 decode logic but no trades are being linked to conditional orders. Possible causes:
   - `transaction.input` may not be populated by HyperSync (verify field_selection is working)
   - The settle calldata decode may be silently failing (the catch blocks swallow errors)
   - Trade matching heuristic (matching by owner) may be too strict — the trade's `owner` field is the Safe/proxy, while the conditional order's owner might be indexed differently
   - Some trades may happen before their conditional order is indexed (block ordering across contracts)

7. **Silent error swallowing** — Both `decodeSettleCalldata` and the handler's try/catch return empty results on failure. Add debug logging to see if calldata is present and decode attempts are happening.

## COWShed

8. **No COWShedProxy entities** — COWShedFactory may not have emitted events yet on the synced block range, or the factory address/event signature may be wrong. Verify the `COWShedBuilt(address user, address shed)` event signature matches what the actual contract emits.
