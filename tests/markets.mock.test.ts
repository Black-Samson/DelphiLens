import { describe, expect, it } from "vitest";
import { sampleMarkets } from "../src/markets/mock";

describe("sample markets", () => {
  const markets = sampleMarkets(new Date("2026-11-23T17:00:00Z"));

  it("covers politics, crypto, economics, technology and sports", () => {
    expect(new Set(markets.map((m) => m.category))).toEqual(
      new Set(["politics", "crypto", "economics", "technology", "sports"]),
    );
  });

  it("uses unique address-like ids and sane odds and times", () => {
    expect(new Set(markets.map((m) => m.marketId)).size).toBe(markets.length);
    for (const m of markets) {
      expect(m.marketId).toMatch(/^0x[0-9a-f]{40}$/);
      expect(m.yesOdds).toBeGreaterThan(0);
      expect(m.yesOdds).toBeLessThan(1);
      expect(new Date(m.evidenceCutoff!).getTime()).toBeLessThan(new Date(m.closeTime!).getTime());
    }
  });
});
