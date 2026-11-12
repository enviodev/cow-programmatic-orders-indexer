import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paced } from "./blockHandlerShared.js";

const ctx = (chainId: number, isPreload = false) => ({ chain: { id: chainId }, isPreload });
const args = (chainId: number, isPreload = false) => ({ block: { number: 1 }, context: ctx(chainId, isPreload) });

describe("paced", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("skips firings until 3x the last run's duration has passed since it ended", async () => {
    let runs = 0;
    const handler = paced("t1", async () => {
      runs++;
      vi.advanceTimersByTime(5_000); // the run takes 5s
    });
    await handler(args(1));
    vi.advanceTimersByTime(14_999);
    await handler(args(1));
    expect(runs).toBe(1);
    vi.advanceTimersByTime(1);
    await handler(args(1));
    expect(runs).toBe(2);
  });

  it("never skips cheap firings", async () => {
    let runs = 0;
    const handler = paced("t2", async () => { runs++; });
    for (let i = 0; i < 5; i++) await handler(args(1));
    expect(runs).toBe(5);
  });

  it("paces each chain separately", async () => {
    const seen: number[] = [];
    const handler = paced("t3", async ({ context }) => {
      seen.push(context.chain.id);
      vi.advanceTimersByTime(1_000);
    });
    await handler(args(1));
    await handler(args(1));
    await handler(args(8453));
    expect(seen).toEqual([1, 8453]);
  });

  it("does nothing in the preload pass", async () => {
    let runs = 0;
    const handler = paced("t4", async () => { runs++; });
    await handler(args(1, true));
    expect(runs).toBe(0);
  });

  it("records the run even when the handler throws", async () => {
    let runs = 0;
    const handler = paced("t5", async () => {
      runs++;
      vi.advanceTimersByTime(1_000);
      throw new Error("boom");
    });
    await expect(handler(args(1))).rejects.toThrow("boom");
    await handler(args(1));
    expect(runs).toBe(1);
  });
});
