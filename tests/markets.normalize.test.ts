import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { normalizeMarket, normalizeMarketList } from "../src/markets/normalize";
import { openDb } from "../src/db";
import { getMarket, saveMarkets } from "../src/markets/store";

describe("market normalizer", () => {
  it("reads camelCase fields", () => {
    const m = normalizeMarket({
      marketAddress: "0xabc",
      question: "Will X happen?",
      category: "Crypto",
      yesOdds: 0.62,
      closeTime: "2026-12-10T17:00:00Z",
      evidenceCutoff: "2026-12-09T17:00:00Z",
      rewardPot: "250.5",
    });
    expect(m).toEqual({
      marketId: "0xabc",
      question: "Will X happen?",
      category: "crypto",
      yesOdds: 0.62,
      closeTime: "2026-12-10T17:00:00.000Z",
      evidenceCutoff: "2026-12-09T17:00:00.000Z",
      rewardPot: 250.5,
      url: null,
      resolutionCriteria: null,
      dataSources: [],
      categoryLabel: null,
    });
  });

  it("reads snake_case, percentages and SDK-style markets", () => {
    const snake = normalizeMarket({ address: "0x1", title: "Q?", yes_price: 62, close_time: 1797000000 });
    expect(snake?.yesOdds).toBe(0.62);
    expect(snake?.closeTime).toMatch(/^2026-/);

    const sdk = normalizeMarket({
      id: "0x2",
      metadata: { question: "From metadata?" },
      category: "politics",
      spotImpliedProbabilities: [0.3, 0.7],
      settlesAt: "2026-12-01T00:00:00Z",
      marketUrl: "https://app/market/1",
    });
    expect(sdk).toMatchObject({ question: "From metadata?", yesOdds: 0.3, url: "https://app/market/1" });
  });

  it("drops entries without an id or question and unwraps lists", () => {
    expect(normalizeMarket({ question: "no id" })).toBeNull();
    expect(normalizeMarket("nope")).toBeNull();
    const list = normalizeMarketList({ markets: [{ id: "0x1", question: "A?" }, { id: "0x2" }] });
    expect(list.map((m) => m.marketId)).toEqual(["0x1"]);
    expect(normalizeMarketList([{ id: "0x9", question: "B?" }])).toHaveLength(1);
    expect(normalizeMarketList(null)).toEqual([]);
  });

  it("ignores impossible odds", () => {
    expect(normalizeMarket({ id: "0x1", question: "Q?", yesOdds: 250 })?.yesOdds).toBeNull();
    expect(normalizeMarket({ id: "0x1", question: "Q?", yesOdds: -1 })?.yesOdds).toBeNull();
  });

  it("reads the real competition markets.json format", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/markets.json"), "utf8"));
    const [cpi, vox] = normalizeMarketList(raw);
    expect(cpi).toMatchObject({
      marketId: "0x0d79f61a3cf6c6a83501fcb6abd22eddb4ab6a58",
      category: "official_statistics",
      categoryLabel: "Official statistics",
      yesOdds: 0.568,
      closeTime: "2026-11-30T08:00:00.000Z",
      evidenceCutoff: "2026-11-29T08:00:00.000Z",
      rewardPot: 20,
      url: "https://delphi.fyi/market/0x0d79f61a3cf6c6a83501fcb6abd22eddb4ab6a58",
      dataSources: ["https://www.destatis.de", "https://www-genesis.destatis.de"],
    });
    expect(cpi.resolutionCriteria).toContain("2.8% or higher");
    expect(vox.yesOdds).toBe(0.483);

    const db = openDb(":memory:");
    saveMarkets(db, [cpi]);
    expect(getMarket(db, cpi.marketId)).toMatchObject({ dataSources: cpi.dataSources, categoryLabel: "Official statistics" });
  });
});
