import { createEffect } from "envio";
import { string, int32, unknown as unknownSchema } from "rescript-schema/src/S.js";

// ─── Chain → API URL mapping ───────────────────────────────────────────────

const API_URLS: Record<number, string> = {
  1: "https://api.cow.fi/mainnet",
  100: "https://api.cow.fi/xdai",
  42161: "https://api.cow.fi/arbitrum_one",
  8453: "https://api.cow.fi/base",
  11155111: "https://api.cow.fi/sepolia",
};

// ─── OrderBook API Effect (cached) ─────────────────────────────────────────
// Fetches all orders for an owner from the CoW Protocol OrderBook API.
// Uses cache: true so results persist across re-indexing runs.
// This is the key advantage over Ponder — bleu flagged this exact problem.

export const fetchOrderBookOrders = createEffect(
  {
    name: "fetchOrderBookOrders",
    input: { owner: string, chainId: int32 },
    output: unknownSchema,
    rateLimit: { calls: 5, per: "second" as const },
    cache: true,
  },
  async ({ input }) => {
    const baseUrl = API_URLS[input.chainId];
    if (!baseUrl) return [];

    try {
      const res = await fetch(
        `${baseUrl}/api/v1/account/${input.owner}/orders`,
      );
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  },
);

// ─── Single Order Status Effect (cached) ───────────────────────────────────

export const fetchOrderStatus = createEffect(
  {
    name: "fetchOrderStatus",
    input: { orderUid: string, chainId: int32 },
    output: unknownSchema,
    rateLimit: { calls: 5, per: "second" as const },
    cache: true,
  },
  async ({ input }) => {
    const baseUrl = API_URLS[input.chainId];
    if (!baseUrl) return undefined;

    try {
      const res = await fetch(
        `${baseUrl}/api/v1/orders/${input.orderUid}`,
      );
      if (!res.ok) return undefined;
      return await res.json();
    } catch {
      return undefined;
    }
  },
);
