import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDigest, latestDigest, renderHtml, renderMarkdown, saveDigest } from "../src/newsletter";
import { testDb } from "./helpers";

const NOW = new Date("2026-11-25T18:00:00Z");
const SINCE = new Date("2026-11-24T18:00:00Z");

function seeded() {
  const db = testDb(["M1", "M2"]);
  db.prepare("UPDATE markets SET first_seen_at = '2026-11-25 09:00:00', reward_pot = 500, category = 'crypto' WHERE market_id = 'M1'").run();
  db.prepare("UPDATE markets SET first_seen_at = '2026-11-20 09:00:00' WHERE market_id = 'M2'").run();
  const insert = db.prepare(
    "INSERT INTO submissions (market_id, stance, note, status, verdict, reason, reward_base_units, judged_at) VALUES (?, ?, ?, 'judged', ?, ?, ?, ?)",
  );
  insert.run("M1", "YES", "a", "accepted", "Primary source <new>.", "2500000", "2026-11-25 10:00:00");
  insert.run("M2", "NO", "b", "rejected", "Already known.", "0", "2026-11-25 11:00:00");
  insert.run("M2", "NO", "c", "accepted", "Old one.", "9000000", "2026-11-20 11:00:00");
  return db;
}

describe("newsletter", () => {
  it("summarizes the period: new markets, verdicts and earnings", () => {
    const d = buildDigest(seeded(), SINCE, NOW);
    expect(d.newMarkets.map((m) => m.marketId)).toEqual(["M1"]);
    expect(d.verdicts).toHaveLength(2);
    expect(d.periodUsdc).toBe(2.5);
    expect(d.stats.totalUsdc).toBe(11.5);
  });

  it("renders markdown with rationales and qualification progress", () => {
    const md = renderMarkdown(buildDigest(seeded(), SINCE, NOW));
    expect(md).toContain("# DelphiLens digest, 2026-11-25");
    expect(md).toContain("Earned this period: **2.50 USDC.e** (total 11.50 USDC.e)");
    expect(md).toContain("Qualification: 3/10 judged submissions, 2/3 markets");
    expect(md).toContain("**ACCEPTED** (YES, 2.50 USDC.e): Question M1?");
    expect(md).toContain("Rationale: Already known.");
  });

  it("renders escaped HTML in the palette", () => {
    const html = renderHtml(buildDigest(seeded(), SINCE, NOW));
    expect(html).toContain("#0A1211");
    expect(html).toContain("Primary source &lt;new&gt;.");
    expect(html).not.toContain("<new>");
  });

  it("handles a quiet period", () => {
    const md = renderMarkdown(buildDigest(testDb([]), SINCE, NOW));
    expect(md).toContain("No new markets.");
    expect(md).toContain("No verdicts this period.");
  });

  it("saves dated files and finds the latest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dig-"));
    const files = saveDigest(buildDigest(seeded(), SINCE, NOW), dir);
    expect(path.basename(files.markdown)).toBe("digest_2026-11-25.md");
    expect(fs.existsSync(files.html)).toBe(true);
    expect(latestDigest(dir)?.file).toBe("digest_2026-11-25.md");
    expect(latestDigest(path.join(dir, "missing"))).toBeNull();
  });
});
