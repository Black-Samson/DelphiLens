import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { countSubmissions, createDraft, lockStance } from "../src/guardrails";
import { sampleMarkets } from "../src/markets/mock";
import { saveMarkets } from "../src/markets/store";
import { MockFetcher } from "../src/research/fetcher";
import { MockLLM } from "../src/research/llm";
import { decideStance, findCandidates, mineMarket, type MinerDeps } from "../src/research/miner";
import type { LLMProvider } from "../src/research/llm";
import { MockSearchProvider } from "../src/research/search";
import { openDb } from "../src/db";

const NOW = new Date("2026-11-24T12:00:00Z");
// A market without listed data sources or an opening time: exercises the general search path.
const market = { ...sampleMarkets(NOW)[6], dataSources: [], resolutionCriteria: null };

function setup() {
  const db = openDb(":memory:");
  saveMarkets(db, [market]);
  const deps: MinerDeps = {
    search: new MockSearchProvider(NOW),
    llm: new MockLLM(),
    fetcher: new MockFetcher(),
    snapshotsDir: fs.mkdtempSync(path.join(os.tmpdir(), "mine-")),
    maxAgeDays: 14,
    now: () => NOW,
  };
  return { db, deps };
}

describe("candidate search", () => {
  it("drops paywalled and stale results and ranks primary first", async () => {
    const { deps } = setup();
    const found = await findCandidates(market, deps);
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((r) => r.url.includes("wsj.com"))).toBe(false);
    expect(found.some((r) => r.url.includes("/archive/"))).toBe(false);
    expect(found[0].url).toMatch(/\.gov\//);
  });

  it("reports progress while it works", async () => {
    const { db, deps } = setup();
    const lines: string[] = [];
    deps.onProgress = (l) => lines.push(l);
    await mineMarket(db, market, deps);
    expect(lines[0]).toBe("Planning searches...");
    expect(lines.some((l) => /^Searching 1\/\d+: /.test(l))).toBe(true);
    expect(lines.some((l) => /^Checking source 1\/\d+: https:/.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/^Writing the note from \d source/);
  });

  it("reports a search summary in the mining log", async () => {
    const { db, deps } = setup();
    deps.search = { search: async () => Promise.reject(new Error("Could not reach Tavily search: connection timed out")) };
    const out = await mineMarket(db, market, deps);
    expect(out.status).toBe("no_evidence");
    expect(out.log[0]).toMatch(/^Search: \d+ searches, \d+ failed \(Could not reach Tavily search: connection timed out\), 0 distinct results, 0 kept to check$/);
  });

  it("skips sources when the AI times out, and stops after 3 failures in a row", async () => {
    const { db, deps } = setup();
    const mock = new MockLLM();
    deps.llm = {
      complete: async (system, prompt) =>
        prompt.startsWith("TASK: VERIFY") ? Promise.reject(new Error("Could not reach the AI service: the request timed out")) : mock.complete(system, prompt),
    };
    const out = await mineMarket(db, market, deps);
    expect(out.status).toBe("no_evidence");
    expect(out.log.filter((l) => l.startsWith("AI check failed (Could not reach the AI service: the request timed out)"))).toHaveLength(3);
    expect(out.log.join("\n")).toMatch(/Stopped: the AI failed 3 times in a row/);
  });

  it("logs a failing search provider and carries on", async () => {
    const { deps } = setup();
    const issues: string[] = [];
    deps.search = { search: async () => Promise.reject(new Error("quota")) };
    deps.onIssue = (kind) => issues.push(kind);
    expect(await findCandidates(market, deps)).toEqual([]);
    expect(issues[0]).toBe("search_error");
  });
});

describe("mineMarket", () => {
  it("creates a YES draft with at most 2 links (3 items with the note) and snapshots", async () => {
    const { db, deps } = setup();
    const out = await mineMarket(db, market, deps);
    expect(out.status).toBe("draft_created");
    expect(out.stance).toBe("YES");
    expect(out.links.length).toBeGreaterThan(0);
    expect(out.links.length).toBeLessThanOrEqual(2);
    expect(out.files.every((f) => fs.existsSync(f))).toBe(true);
    expect(out.links.some((l) => l.includes("localnews"))).toBe(false);
    expect(out.note).toMatch(/\n\nSources:\n1\. "The agency confirmed the measure/);
    expect(out.note).toContain(`published 2026-11-22) ${out.links[0]}`);
    expect(countSubmissions(db, market.marketId)).toBe(1);
  });

  it("never argues against a locked stance", async () => {
    const { db, deps } = setup();
    lockStance(db, market.marketId, "NO");
    const out = await mineMarket(db, market, deps);
    expect(out.status).toBe("no_evidence");
    expect(out.log.join()).toMatch(/locked to NO/);
  });

  it("never reuses a source", async () => {
    const { db, deps } = setup();
    const first = await mineMarket(db, market, deps);
    const second = await mineMarket(db, market, deps);
    expect(first.links.filter((l) => second.links.includes(l))).toEqual([]);
  });

  it("skips a fact that was already drafted, even from a different link", async () => {
    const { db, deps } = setup();
    const first = await mineMarket(db, market, deps);
    // Same facts, reworded, under new URLs: the same-fact check must catch them.
    deps.search = {
      search: async (q) =>
        (await new MockSearchProvider(NOW).search(q)).map((r) => ({ ...r, url: r.url.replace("agency.example.gov", "mirror.example.gov") })),
    };
    const realFetch = deps.fetcher;
    deps.fetcher = { fetch: (url) => realFetch.fetch(url.replace("mirror.example.gov", "agency.example.gov")) };
    const second = await mineMarket(db, market, deps);
    expect(first.status).toBe("draft_created");
    expect(second.log.join("\n")).toMatch(/Same fact as submission #1/);
    expect(second.links.some((l) => l.includes("mirror.example.gov"))).toBe(false);
  });

  it("stops at the per-market cap", async () => {
    const { db, deps } = setup();
    for (const n of [1, 2, 3]) {
      createDraft(db, { marketId: market.marketId, stance: "YES", note: `Seed ${n}.`, links: [`https://seed.gov/${n}`] });
    }
    const out = await mineMarket(db, market, deps);
    expect(out.status).toBe("blocked");
  });
});

describe("choosing a side from all the evidence", () => {
  it("needs one side to clearly outweigh the other", () => {
    expect(decideStance([{ stance: "YES", confidence: 0.8 }]).stance).toBe("YES");
    expect(decideStance([{ stance: "YES", confidence: 0.6 }, { stance: "NO", confidence: 0.9 }, { stance: "NO", confidence: 0.7 }]).stance).toBe("NO");
    expect(decideStance([{ stance: "YES", confidence: 0.7 }, { stance: "NO", confidence: 0.6 }]).stance).toBeNull();
    expect(decideStance([{ stance: null, confidence: 0.2 }]).reason).toBe("No directional evidence");
  });

  /** A verifier that argues NO for GitHub sources and YES for everything else. */
  class SplitLLM implements LLMProvider {
    constructor(private noConfidence: number) {}
    private mock = new MockLLM();
    async complete(system: string, prompt: string) {
      if (!prompt.startsWith("TASK: VERIFY")) return this.mock.complete(system, prompt);
      const github = /^SOURCE_URL: https:\/\/github\.com/m.test(prompt);
      return JSON.stringify({
        publicly_accessible: true,
        verifiable: true,
        shifts_probability: true,
        stance: github ? "NO" : "YES",
        confidence: github ? this.noConfidence : 0.6,
        reason: "split",
        fact: "A dated fact.",
        quote: null,
      });
    }
  }

  /** Alternates YES and NO with equal confidence: a perfectly mixed picture. */
  class AlternatingLLM implements LLMProvider {
    private n = 0;
    private mock = new MockLLM();
    async complete(system: string, prompt: string) {
      if (!prompt.startsWith("TASK: VERIFY")) return this.mock.complete(system, prompt);
      return JSON.stringify({
        publicly_accessible: true,
        verifiable: true,
        shifts_probability: true,
        stance: this.n++ % 2 ? "NO" : "YES",
        confidence: 0.7,
        reason: "alternating",
        fact: `Fact ${this.n}.`,
        quote: null,
      });
    }
  }

  it("does not lock a side when the evidence is mixed", async () => {
    const { db, deps } = setup();
    deps.llm = new AlternatingLLM();
    const out = await mineMarket(db, market, deps);
    expect(out.status).toBe("no_evidence");
    expect(out.log.join()).toMatch(/mixed/);
    expect(countSubmissions(db, market.marketId)).toBe(0);
  });

  it("keeps only the winning side's sources when one side clearly leads", async () => {
    const { db, deps } = setup();
    deps.llm = new SplitLLM(0.1);
    const out = await mineMarket(db, market, deps);
    expect(out.status).toBe("draft_created");
    expect(out.stance).toBe("YES");
    expect(out.links.some((l) => l.includes("github.com"))).toBe(false);
    expect(out.log.join()).toMatch(/Skipped NO evidence: leaning YES/);
  });
});

describe("markets with official data sources", () => {
  it("searches the data sources first and ignores facts from before the market opened", async () => {
    const { db, deps } = setup();
    const opened = new Date(NOW.getTime() - 1.5 * 86_400_000).toISOString();
    const cpi = {
      ...sampleMarkets(NOW)[2],
      dataSources: ["https://www.destatis.de"],
      resolutionCriteria: `Wins if the rate, published strictly after ${opened} and at or before ...`,
    };
    saveMarkets(db, [cpi]);
    const found = await findCandidates(cpi, deps);
    // The listed data source itself comes first, then search results from that site.
    expect(found[0].url).toBe("https://www.destatis.de");
    expect(new URL(found[1].url).hostname).toBe("destatis.de");
    // The agency.example.gov release is 2 days old, from before the market opened.
    expect(found.some((r) => r.url.includes("agency.example.gov/releases"))).toBe(false);
    const out = await mineMarket(db, cpi, deps);
    expect(out.links[0]).toContain("destatis.de");
  });

  it("checks a live JSON data source directly and dates it by when it was read", async () => {
    const { db, deps } = setup();
    const wiki = {
      ...sampleMarkets(NOW)[5],
      question: "Will English Wikipedia siteinfo API show at least 7,275,500 articles on Dec 10, 2026?",
      dataSources: ["https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo&siprop=statistics"],
      resolutionCriteria: null,
    };
    saveMarkets(db, [wiki]);
    deps.now = () => new Date();
    deps.search = { search: async () => [] };
    deps.fetcher = {
      fetch: async (url) =>
        url.includes("wikipedia")
          ? { text: '{"articles": 7273000} The count was confirmed as released.', published: null, retrievedAt: new Date().toISOString() }
          : null,
    };
    const out = await mineMarket(db, wiki, deps);
    expect(out.status).toBe("draft_created");
    expect(out.links).toEqual([wiki.dataSources[0]]);
    expect(out.note).toMatch(/live data read \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  });

  it("lists a market data source only once, even when spelled with paging params", async () => {
    const { deps } = setup();
    deps.search = { search: async () => [] };
    const bun = {
      ...sampleMarkets(NOW)[4],
      question: "Will oven-sh/bun publish a GitHub release tagged bun-v1.4.6 or later between Nov 28 and Dec 11, 2026 (UTC)?",
      dataSources: ["https://api.github.com/repos/oven-sh/bun/releases"],
      resolutionCriteria: null,
    };
    const found = await findCandidates(bun, deps);
    expect(found.filter((r) => r.url.includes("api.github.com"))).toHaveLength(1);
  });
});
