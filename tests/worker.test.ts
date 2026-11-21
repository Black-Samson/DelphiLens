import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { computeStats } from "../src/stats";
import { runCycle } from "../src/worker";

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
