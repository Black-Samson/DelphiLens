import { describe, expect, it, vi } from "vitest";
import { loadSettings } from "../src/config";
import { openDb } from "../src/db";
import { fetchMarkets } from "../src/markets/source";
import { getMarket, listMarkets, saveMarkets } from "../src/markets/store";

describe("market sources", () => {
  it("returns sample markets in mock mode", async () => {
    const markets = await fetchMarkets(loadSettings({}));
    expect(markets.length).toBeGreaterThanOrEqual(8);
  });

  it("reads a markets.json url and sends the agent id", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ markets: [{ id: "0x1", question: "Q?" }] })));
    const settings = loadSettings({ MOCK_MODE: "false", MARKETS_SOURCE: "url", MARKETS_URL: "https://x/markets.json" });
    const markets = await fetchMarkets(settings, { fetch: fetchFn as unknown as typeof fetch });
    expect(markets.map((m) => m.marketId)).toEqual(["0x1"]);
    const init = (fetchFn.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Agent-Id"]).toBe("DelphiLens");
  });

  it("reads open markets with prices through the SDK", async () => {
    const listMarkets = vi.fn(async () => ({
      markets: [{ id: "0x2", metadata: { question: "SDK?" }, spotImpliedProbabilities: [0.4, 0.6] }],
    }));
    const settings = loadSettings({ MOCK_MODE: "false", MARKETS_SOURCE: "sdk", DELPHI_API_ACCESS_KEY: "k" });
    const markets = await fetchMarkets(settings, { sdkClient: { listMarkets } as never });
    expect(markets[0]).toMatchObject({ marketId: "0x2", question: "SDK?", yesOdds: 0.4 });
    expect(listMarkets).toHaveBeenCalledWith(expect.objectContaining({ status: "open", pricesAndImpliedProbabilities: true }));
  });

  it("explains missing configuration", async () => {
    await expect(fetchMarkets(loadSettings({ MOCK_MODE: "false", MARKETS_SOURCE: "url" }))).rejects.toThrow(/MARKETS_URL/);
    await expect(fetchMarkets(loadSettings({ MOCK_MODE: "false", MARKETS_SOURCE: "sdk" }))).rejects.toThrow(/DELPHI_API_ACCESS_KEY/);
  });
});

describe("market store", () => {
  it("upserts markets and reports which were new", async () => {
    const db = openDb(":memory:");
    const markets = await fetchMarkets(loadSettings({}));
    expect(saveMarkets(db, markets)).toHaveLength(markets.length);
    expect(saveMarkets(db, [{ ...markets[0], yesOdds: 0.9 }])).toEqual([]);
    expect(getMarket(db, markets[0].marketId)?.yesOdds).toBe(0.9);
    expect(listMarkets(db)).toHaveLength(markets.length);
  });
});
