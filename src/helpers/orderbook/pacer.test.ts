import { describe, expect, it } from "vitest";
import { RequestPacer } from "./pacer.js";

function pacerAt(intervalMs: number, maxWaitMs: number) {
  const clock = { t: 1_000_000 };
  return { clock, pacer: new RequestPacer(intervalMs, maxWaitMs, () => clock.t) };
}

describe("RequestPacer", () => {
  it("spaces requests by the interval", () => {
    const { pacer } = pacerAt(750, 4_000);
    expect(pacer.reserve()).toBe(0);
    expect(pacer.reserve()).toBe(750);
    expect(pacer.reserve()).toBe(1_500);
  });

  it("refuses a request that would wait past maxWait, without reserving", () => {
    const { pacer } = pacerAt(1_000, 2_000);
    expect([pacer.reserve(), pacer.reserve(), pacer.reserve()]).toEqual([0, 1_000, 2_000]);
    expect(pacer.reserve()).toBeNull();
    expect(pacer.reserve()).toBeNull();
  });

  it("frees slots as time passes", () => {
    const { clock, pacer } = pacerAt(1_000, 0);
    expect(pacer.reserve()).toBe(0);
    expect(pacer.reserve()).toBeNull();
    clock.t += 1_000;
    expect(pacer.reserve()).toBe(0);
  });

  it("holds the lane for a 429 penalty", () => {
    const { clock, pacer } = pacerAt(750, 4_000);
    pacer.block(30_000);
    expect(pacer.reserve()).toBeNull();
    clock.t += 27_000;
    expect(pacer.reserve()).toBe(3_000);
    clock.t += 3_000;
    expect(pacer.reserve()).toBe(750);
  });

  it("never shortens an existing penalty", () => {
    const { clock, pacer } = pacerAt(0, 0);
    pacer.block(30_000);
    pacer.block(1_000);
    clock.t += 29_000;
    expect(pacer.reserve()).toBeNull();
    clock.t += 1_000;
    expect(pacer.reserve()).toBe(0);
  });
});
