import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { compareReadings, numericLeaves, saveReading, trendNote } from "../src/research/readings";

const body = (articles: number) => JSON.stringify({ query: { statistics: { articles, pages: "100" } } });

describe("numericLeaves", () => {
  it("flattens numbers and numeric strings by path", () => {
    const leaves = numericLeaves(JSON.parse(body(5)));
    expect(leaves.get("query.statistics.articles")).toBe(5);
    expect(leaves.get("query.statistics.pages")).toBe(100);
  });
});

describe("compareReadings", () => {
  it("reports the change and the pace per day", () => {
    const lines = compareReadings(body(7_270_000), "2026-11-28T00:00:00Z", body(7_270_600), "2026-11-29T00:00:00Z");
    expect(lines).toEqual([
      "query.statistics.articles: 7,270,000 → 7,270,600 (+600 in 24.0 h, about 600 per day)",
    ]);
  });
  it("ignores readings too close together or unparseable", () => {
    expect(compareReadings(body(1), "2026-11-28T00:00:00Z", body(2), "2026-11-28T01:00:00Z")).toEqual([]);
    expect(compareReadings("not json", "2026-11-28T00:00:00Z", body(2), "2026-11-29T00:00:00Z")).toEqual([]);
  });
});

describe("trendNote", () => {
  it("uses the latest reading at least a few hours old", () => {
    const db = openDb(":memory:");
    const url = "https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo&siprop=statistics&format=json";
    expect(trendNote(db, url, "2026-11-28T12:00:00Z", body(10))).toBe("");
    saveReading(db, url, "2026-11-28T00:00:00Z", body(0));
    saveReading(db, url, "2026-11-28T11:00:00Z", body(9));
    const note = trendNote(db, url, "2026-11-28T12:00:00Z", body(12));
    expect(note).toContain("read at 2026-11-28T00:00:00Z");
    expect(note).toContain("+12 in 12.0 h, about 24 per day");
  });
});
