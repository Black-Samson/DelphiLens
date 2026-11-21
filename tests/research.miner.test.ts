import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { countSubmissions, createDraft, lockStance } from "../src/guardrails";
import { sampleMarkets } from "../src/markets/mock";
import { saveMarkets } from "../src/markets/store";
import { MockFetcher } from "../src/research/fetcher";
import { MockLLM } from "../src/research/llm";
import { findCandidates, mineMarket, type MinerDeps } from "../src/research/miner";
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

  it("stops at the per-market cap", async () => {
    const { db, deps } = setup();
    for (const n of [1, 2, 3]) {
      createDraft(db, { marketId: market.marketId, stance: "YES", note: `Seed ${n}.`, links: [`https://seed.gov/${n}`] });
    }
    const out = await mineMarket(db, market, deps);
    expect(out.status).toBe("blocked");
  });
});
