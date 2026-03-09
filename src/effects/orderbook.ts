import { createEffect, S } from "envio";

// ─── Chain → API URL mapping ───────────────────────────────────────────────

const API_URLS: Record<number, string> = {
  1: "https://api.cow.fi/mainnet",
  100: "https://api.cow.fi/xdai",
  42161: "https://api.cow.fi/arbitrum_one",
  8453: "https://api.cow.fi/base",
  11155111: "https://api.cow.fi/sepolia",
};

export interface OrderBookOrder {
  uid: string;
  owner?: string;
  status?: string;
  sellToken?: string;
  buyToken?: string;
  sellAmount?: string;
  buyAmount?: string;
  validTo?: number;
}

// ─── OrderBook API Effect (cached) ─────────────────────────────────────────
// Fetches all orders for an owner from the CoW Protocol OrderBook API.
// Uses cache: true so results persist across re-indexing runs.
// Output is JSON-stringified to avoid PostgreSQL array serialization issues.

export const fetchOrderBookOrders = createEffect(
  {
    name: "fetchOrderBookOrders",
    input: { owner: S.string, chainId: S.number },
    output: S.string,
    rateLimit: { calls: 5, per: "second" as const },
    cache: true,
  },
  async ({ input }): Promise<string> => {
    const baseUrl = API_URLS[input.chainId];
    if (!baseUrl) return "[]";

    try {
      const res = await fetch(
        `${baseUrl}/api/v1/account/${input.owner}/orders`,
      );
      if (!res.ok) return "[]";
      const data = await res.json();
      return JSON.stringify(data);
    } catch {
      return "[]";
    }
  },
);

// ─── Single Order Status Effect (cached) ───────────────────────────────────

export const fetchOrderStatus = createEffect(
  {
    name: "fetchOrderStatus",
    input: { orderUid: S.string, chainId: S.number },
    output: S.union([S.string, null]),
    rateLimit: { calls: 5, per: "second" as const },
    cache: true,
  },
  async ({ input }): Promise<string | null> => {
    const baseUrl = API_URLS[input.chainId];
    if (!baseUrl) return null;

    try {
      const res = await fetch(
        `${baseUrl}/api/v1/orders/${input.orderUid}`,
      );
      if (!res.ok) return null;
      const data = await res.json();
      return JSON.stringify(data);
    } catch {
      return null;
    }
  },
);
