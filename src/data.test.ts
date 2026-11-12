import { afterEach, describe, expect, it, vi } from "vitest";

// ORDERBOOK_API_URLS is built at module load, so each case re-imports data.ts.
async function urlsWith(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
  vi.resetModules();
  return (await import("./data.js")).ORDERBOOK_API_URLS;
}

describe("ORDERBOOK_API_URLS", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to api.cow.fi", async () => {
    const urls = await urlsWith({});
    expect(urls[1]).toBe("https://api.cow.fi/mainnet");
    expect(urls[42161]).toBe("https://api.cow.fi/arbitrum_one");
  });

  it("applies the template with dashed network names and trims trailing slashes", async () => {
    const urls = await urlsWith({
      ENVIO_ORDERBOOK_API_URL_TEMPLATE: "http://{network}-api-prod.services.svc.cluster.local//",
    });
    expect(urls[1]).toBe("http://mainnet-api-prod.services.svc.cluster.local");
    expect(urls[42161]).toBe("http://arbitrum-one-api-prod.services.svc.cluster.local");
  });

  it("accepts the unprefixed upstream name locally", async () => {
    const urls = await urlsWith({ ORDERBOOK_API_URL_TEMPLATE: "http://proxy/{network}" });
    expect(urls[100]).toBe("http://proxy/xdai");
  });
});
