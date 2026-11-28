import { describe, expect, it } from "vitest";
import { liveTrackers, questionDate } from "../src/research/trackers";

describe("questionDate", () => {
  it("reads US and European date styles", () => {
    expect(questionDate("federal vote of Nov 29, 2026?")).toBe("20261129");
    expect(questionDate("the 19 Dec 2025 amendment")).toBe("20251219");
    expect(questionDate("no date here")).toBeNull();
  });
});

describe("liveTrackers", () => {
  it("adds Geneva's running turnout page for Swiss votes", () => {
    const t = liveTrackers({ question: "Will turnout in Switzerland's federal vote of Nov 29, 2026 be at least 50.0%?" });
    expect(t.map((x) => x.url)).toEqual(["https://www.ge.ch/votations/20261129/"]);
  });
  it("leaves other markets alone", () => {
    expect(liveTrackers({ question: "Will Vox win ≥60 seats in Spain's Nov 29, 2026 general election?" })).toEqual([]);
  });
});
