import { describe, expect, it } from "vitest";
import { computeStats, earningsSeries } from "../src/stats";
import { testDb } from "./helpers";

function judged(db: ReturnType<typeof testDb>, market: string, verdict: string, reward: string, day: string) {
  db.prepare(
    "INSERT INTO submissions (market_id, stance, note, status, verdict, reward_base_units, judged_at) VALUES (?, 'YES', ?, 'judged', ?, ?, ?)",
  ).run(market, Math.random().toString(), verdict, reward, `${day} 10:00:00`);
}

describe("stats", () => {
  it("totals rewards and acceptance", () => {
    const db = testDb();
    judged(db, "M1", "accepted", "2500000", "2026-11-24");
    judged(db, "M2", "rejected", "0", "2026-11-24");
    judged(db, "M3", "accepted", "1000000", "2026-11-25");
    db.prepare("INSERT INTO submissions (market_id, stance, note, status) VALUES ('M4', 'NO', 'q', 'queued')").run();
    db.prepare("INSERT INTO submissions (market_id, stance, note, status) VALUES ('M4', 'NO', 'd', 'draft')").run();
    const s = computeStats(db);
    expect(s).toMatchObject({ totalUsdc: 3.5, judged: 3, accepted: 2, rejected: 1, pending: 1, drafts: 1, activeMarkets: 4 });
    expect(s.acceptanceRate).toBeCloseTo(2 / 3);
    expect(s.qualification).toEqual({ judged: 3, markets: 3, qualified: false });
    expect(earningsSeries(db)).toEqual([
      { date: "2026-11-24", usdc: 2.5, cumulative: 2.5 },
      { date: "2026-11-25", usdc: 1, cumulative: 3.5 },
    ]);
  });

  it("handles an empty database", () => {
    expect(computeStats(testDb([])).acceptanceRate).toBe(0);
    expect(earningsSeries(testDb([]))).toEqual([]);
  });
});
