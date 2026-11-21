import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { computeStats } from "../src/stats";
import { checkForNewMarkets, newUnminedMarkets, runCycle } from "../src/worker";
import { saveMarkets } from "../src/markets/store";
import { sampleMarkets } from "../src/markets/mock";

function app(autoSubmit: boolean) {
  const a = createApp({ dbPath: ":memory:", env: { AUTO_SUBMIT: String(autoSubmit) } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wk-"));
  a.settings = { ...a.settings, reportsDir: path.join(dir, "reports"), snapshotsDir: path.join(dir, "snaps") };
  return a;
}

describe("worker cycle", () => {
  it("mines drafts for manual approval and writes a digest", async () => {
    const a = app(false);
    const s = await runCycle(a, { sendDigest: false });
    expect(s.marketsSeen).toBeGreaterThanOrEqual(8);
    expect(s.newMarkets).toBe(s.marketsSeen);
    expect(s.drafts).toBeGreaterThan(0);
    expect(s.submitted).toBe(0);
    expect(computeStats(a.db).drafts).toBe(s.drafts);
    expect(s.digest && fs.existsSync(s.digest)).toBe(true);
  });

  it("does not re-mine a market whose draft is waiting for review", async () => {
    const a = app(false);
    const first = await runCycle(a, { sendDigest: false, maxMarkets: 2 });
    const second = await runCycle(a, { sendDigest: false, maxMarkets: 2 });
    const perMarket = a.db
      .prepare("SELECT market_id, COUNT(*) AS c FROM submissions GROUP BY market_id")
      .all() as { c: number }[];
    expect(first.drafts + second.drafts).toBe(perMarket.length);
    expect(perMarket.every((r) => r.c === 1)).toBe(true);
    expect(second.digest).toBeNull();
  });

  it("auto-submits when allowed", async () => {
    const a = app(true);
    const s = await runCycle(a, { sendDigest: false });
    expect(s.submitted).toBe(s.drafts);
    expect(computeStats(a.db).drafts).toBe(0);
  });
});

describe("new markets", () => {
  it("mines brand-new markets before older ones", async () => {
    const a = app(false);
    const now = new Date();
    // Pretend every sample market was seen two days ago and already qualified the pot order...
    saveMarkets(a.db, sampleMarkets(now));
    a.db.prepare("UPDATE markets SET first_seen_at = datetime('now', '-2 days')").run();
    // ...except one small-pot market that just opened.
    const newest = sampleMarkets(now)[6].marketId;
    a.db.prepare("UPDATE markets SET first_seen_at = datetime('now') WHERE market_id = ?").run(newest);
    expect([...newUnminedMarkets(a, now)]).toEqual([newest]);

    const lines: string[] = [];
    await runCycle(a, { sendDigest: false, maxMarkets: 1, now, log: (l) => lines.push(l) });
    const first = a.db.prepare("SELECT market_id FROM submissions ORDER BY id LIMIT 1").get() as { market_id: string };
    expect(first.market_id).toBe(newest);
    expect(lines.join()).toMatch(/New markets first: 1/);
    expect(newUnminedMarkets(a, now).size).toBe(0);
  });

  it("checkForNewMarkets reports only markets it has not seen", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nm-"));
    const make = () => createApp({ dbPath: path.join(dir, "t.db"), env: {} });
    const lines: string[] = [];
    expect(await checkForNewMarkets(make, (l) => lines.push(l))).toBeGreaterThan(0);
    expect(await checkForNewMarkets(make)).toBe(0);
    expect(lines[0]).toMatch(/new market\(s\) opened/);
    expect(await checkForNewMarkets(() => { throw new Error("offline"); }, (l) => lines.push(l))).toBe(0);
    expect(lines.at(-1)).toMatch(/offline/);
  });
});
