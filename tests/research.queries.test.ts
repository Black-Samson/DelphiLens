import { describe, expect, it } from "vitest";
import { classifySource, isFresh, isPaywalled, marketOpenedAt, rankResults } from "../src/research/sources";
import { coreTopic, dataSourceHosts, decomposeQuestion, MAX_QUERIES, searchPlan } from "../src/research/queries";

const NOW = new Date("2026-11-24T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe("query decomposition", () => {
  it("strips the lead verb and the deadline", () => {
    expect(coreTopic("Will the SEC approve staking in a spot Ethereum ETF before Jan 15?")).toBe(
      "the SEC approve staking in a spot Ethereum ETF",
    );
    expect(coreTopic("Will Bitcoin close above $100,000 on Dec 31, 2026?")).toBe("Bitcoin close above $100,000");
  });

  it("adds category queries without duplicates and respects the cap", () => {
    const crypto = decomposeQuestion({ question: "Will X happen?", category: "crypto" });
    expect(crypto.some((q) => q.includes("SEC filing"))).toBe(true);
    expect(new Set(crypto).size).toBe(crypto.length);
    expect(crypto.length).toBeLessThanOrEqual(MAX_QUERIES);
    expect(decomposeQuestion({ question: "Will Y?", category: "unknown" })[0]).toBe("Y");
  });
});

describe("source quality", () => {
  it.each([
    ["https://www.sec.gov/x", "primary"],
    ["https://github.com/o/r/commit/1", "primary"],
    ["https://ec.europa.eu/news", "primary"],
    ["https://nbs.example.gov/x", "primary"],
    ["https://www.reuters.com/x", "news"],
    ["https://random-blog.com/x", "other"],
    ["not a url", "other"],
  ])("%s is %s", (url, kind) => {
    expect(classifySource(url)).toBe(kind);
  });

  it("detects paywalls", () => {
    expect(isPaywalled("https://www.wsj.com/articles/x")).toBe(true);
    expect(isPaywalled("https://markets.ft.com/x")).toBe(true);
    expect(isPaywalled("https://www.sec.gov/x")).toBe(false);
  });
});

describe("freshness", () => {
  const cutoff = new Date(NOW.getTime() + 3 * 86_400_000).toISOString();
  it("keeps recent dated results only", () => {
    expect(isFresh(daysAgo(2), cutoff, 14, NOW)).toBe(true);
    expect(isFresh(daysAgo(40), cutoff, 14, NOW)).toBe(false);
    expect(isFresh(null, cutoff, 14, NOW)).toBe(false);
    expect(isFresh(daysAgo(-2), cutoff, 14, NOW)).toBe(false);
  });

  it("never keeps results dated after a past cutoff", () => {
    const pastCutoff = daysAgo(1);
    expect(isFresh(daysAgo(0.5), pastCutoff, 14, NOW)).toBe(false);
    expect(isFresh(daysAgo(3), pastCutoff, 14, NOW)).toBe(true);
  });
});

describe("ranking", () => {
  it("puts primary sources first, then the newest", () => {
    const r = (url: string, d: number | null) => ({ title: "t", url, snippet: "", published: d === null ? null : daysAgo(d) });
    const ranked = rankResults([
      r("https://blog.com/a", 1),
      r("https://www.reuters.com/a", 1),
      r("https://a.gov/old", 6),
      r("https://a.gov/undated", null),
      r("https://a.gov/new", 2),
    ]).map((x) => x.url);
    expect(ranked).toEqual([
      "https://a.gov/new",
      "https://a.gov/old",
      "https://a.gov/undated",
      "https://www.reuters.com/a",
      "https://blog.com/a",
    ]);
  });
});

describe("market data sources", () => {
  const market = {
    question: "Will Destatis's preliminary German CPI annual rate for Nov 2026 be 2.8% or higher?",
    category: "official_statistics",
    dataSources: ["https://www.destatis.de", "https://www-genesis.destatis.de/x", "https://www.reuters.com", "not a url"],
  };

  it("searches the market's official sources first", () => {
    expect(dataSourceHosts(market)).toEqual(["destatis.de", "www-genesis.destatis.de"]);
    const plan = searchPlan(market);
    expect(plan[0]).toEqual({ query: coreTopic(market.question), domains: ["destatis.de", "www-genesis.destatis.de"] });
    expect(plan.slice(1).every((q) => !q.domains)).toBe(true);
    expect(plan.some((q) => q.query.includes("flash estimate"))).toBe(true);
    expect(searchPlan({ ...market, dataSources: [] })[0].domains).toBeUndefined();
  });

  it("treats a market's data sources as primary", () => {
    expect(classifySource("https://www.destatis.de/press/1")).toBe("other");
    expect(classifySource("https://www.destatis.de/press/1", ["destatis.de"])).toBe("primary");
  });

  it("finds when the market opened from its resolution criteria", () => {
    expect(marketOpenedAt('Wins if ... published strictly after 2026-11-24T09:17:34.007Z and at or before ...')).toBe(
      "2026-11-24T09:17:34.007Z",
    );
    expect(marketOpenedAt("No timestamp here")).toBeNull();
    // A future "strictly after" is a counting window start, not the opening time.
    expect(marketOpenedAt("released strictly after 2026-11-28T00:00:00.000Z", new Date("2026-11-26T08:00:00Z"))).toBeNull();
    expect(marketOpenedAt(null)).toBeNull();
  });

  it("treats facts from before the market opened as already priced", () => {
    const opened = daysAgo(1);
    expect(isFresh(daysAgo(3), null, 14, NOW, opened)).toBe(false);
    expect(isFresh(daysAgo(0.5), null, 14, NOW, opened)).toBe(true);
  });
});
