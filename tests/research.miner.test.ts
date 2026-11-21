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
const market = sampleMarkets(NOW)[4];

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
  it("creates a YES draft with up to 3 links and snapshots", async () => {
    const { db, deps } = setup();
    const out = await mineMarket(db, market, deps);
    expect(out.status).toBe("draft_created");
    expect(out.stance).toBe("YES");
    expect(out.links.length).toBeGreaterThan(0);
    expect(out.links.length).toBeLessThanOrEqual(3);
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

  it("does not lock a side when the evidence is mixed", async () => {
    const { db, deps } = setup();
    deps.llm = new SplitLLM(3);
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
