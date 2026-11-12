import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOrdersByUidsRaw } from "./orderbook.js";

const uid = (i: number) => `0x${i.toString(16).padStart(112, "0")}`;

describe("fetchOrdersByUidsRaw", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the UIDs of failed chunks as unanswered, not as missing orders", async () => {
    const uids = Array.from({ length: 150 }, (_, i) => uid(i)); // two chunks: 100 + 50
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const chunk = JSON.parse(String(init.body)) as string[];
      if (chunk.length === 100) {
        return new Response(JSON.stringify([{ order: { uid: chunk[0], status: "fulfilled" } }]), { status: 200 });
      }
      return new Response("bad request", { status: 400 }); // not retryable
    }));

    const result = await fetchOrdersByUidsRaw("https://api.example", uids);

    expect(result.orders.map((o) => o.uid)).toEqual([uids[0]]);
    expect(result.unanswered).toEqual(uids.slice(100));
  });
});
