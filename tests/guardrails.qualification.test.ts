import { describe, expect, it } from "vitest";
import { isContested, prioritizeMarkets, qualificationProgress } from "../src/guardrails";
import { insertSubmission, testDb } from "./helpers";

const market = (marketId: string, rewardPot: number, yesOdds: number | null = 0.5, cutoff: string | null = null) => ({
  marketId,
  rewardPot,
  yesOdds,
  evidenceCutoff: cutoff,
});

describe("qualification", () => {
  it("needs 10 judged submissions across 3 markets", () => {
    const db = testDb(["M1", "M2", "M3", "M4"]);
    for (const m of ["M1", "M2", "M3"]) for (let i = 0; i < 3; i++) insertSubmission(db, m, "YES", "judged");
    insertSubmission(db, "M4", "YES", "queued");
    expect(qualificationProgress(db)).toEqual({ judged: 9, markets: 3, qualified: false });
    insertSubmission(db, "M4", "YES", "judged");
    expect(qualificationProgress(db)).toEqual({ judged: 10, markets: 4, qualified: true });
  });

  it("does not qualify with 10 judged submissions on only 2 markets", () => {
    const db = testDb(["M1", "M2"]);
    for (let i = 0; i < 5; i++) {
      insertSubmission(db, "M1", "YES", "judged");
      insertSubmission(db, "M2", "YES", "judged");
    }
    expect(qualificationProgress(db).qualified).toBe(false);
  });
});

describe("market prioritizer", () => {
  it("spreads across untouched markets first and skips full ones", () => {
    const db = testDb();
    insertSubmission(db, "M1", "YES");
    for (let i = 0; i < 3; i++) insertSubmission(db, "M4", "YES");
    const order = prioritizeMarkets(db, [market("M1", 900), market("M2", 5), market("M3", 50), market("M4", 999)]);
    expect(order.map((m) => m.marketId)).toEqual(["M3", "M2", "M1"]);
  });

  it("prefers contested markets and skips closed evidence windows", () => {
    const db = testDb();
    const now = new Date("2026-11-25T00:00:00Z");
    const order = prioritizeMarkets(
      db,
      [
        market("M1", 900, 0.97),
        market("M2", 100, 0.45),
        market("M3", 500, 0.5, "2026-11-24T00:00:00Z"),
      ],
      now,
    );
    expect(order.map((m) => m.marketId)).toEqual(["M2", "M1"]);
  });

  it("treats 20% to 80% as contested", () => {
    expect([isContested(0.2), isContested(0.8), isContested(0.1), isContested(null)]).toEqual([
      true,
      true,
      false,
      true,
    ]);
  });
});
