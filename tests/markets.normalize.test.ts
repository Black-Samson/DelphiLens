import { describe, expect, it } from "vitest";
import { normalizeMarket, normalizeMarketList } from "../src/markets/normalize";

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
});
