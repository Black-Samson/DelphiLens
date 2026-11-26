import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { recentLessons } from "../src/research/lessons";
import { verifyEvidence } from "../src/research/verifier";
import { sampleMarkets } from "../src/markets/mock";

describe("learning from verdicts", () => {
  it("collects reasons for submissions that earned nothing", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO markets (market_id, question) VALUES ('m', 'Will Bun release?')").run();
    const add = db.prepare(
      "INSERT INTO submissions (market_id, stance, note, status, verdict, reason, judged_at) VALUES ('m', 'YES', ?, 'judged', ?, ?, ?)",
    );
    add.run("Release rhythm summary.\nSources: ...", "duplicate", "We already have this information.", "2026-11-26 09:58:00");
    add.run("A good one.", "accepted", "New and useful.", "2026-11-26 10:00:00");
    expect(recentLessons(db)).toEqual(['DUPLICATE: "We already have this information." (we sent: Release rhythm summary.)']);
  });

  it("passes the lessons to the AI", async () => {
    const prompts: string[] = [];
    const llm = { complete: async (_s: string, p: string) => (prompts.push(p), "{}") };
    const market = sampleMarkets()[4];
    await verifyEvidence(llm, market, { title: "t", url: "https://a.gov", snippet: "", published: null }, "text", [
      'DUPLICATE: "We already have this information." (we sent: Release rhythm summary.)',
    ]);
    expect(prompts[0]).toContain("What Delphi's judge said about our earlier submissions");
    expect(prompts[0]).toContain("- DUPLICATE: \"We already have this information.\"");
  });
});
