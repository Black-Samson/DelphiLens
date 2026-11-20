import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { classify, exportFeedbackReport, listFeedback, logFeedback } from "../src/feedback";

describe("feedback tracker", () => {
  it("groups repeats of the same issue", () => {
    const db = openDb(":memory:");
    logFeedback(db, "poll_error", "Timeout on submission 1234 for 0xabc");
    logFeedback(db, "poll_error", "Timeout on submission 5678 for 0xdef");
    logFeedback(db, "ambiguous_market", "Question does not say which time zone 'Dec 31' uses");
    const entries = listFeedback(db);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "poll_error", count: 2 });
  });

  it("classifies rate limits and unknown kinds", () => {
    expect(classify("api_error", "rate_limited: hourly")).toBe("rate_limit");
    expect(classify("weird", "x")).toBe("note");
    expect(classify("llm_error", "bad json")).toBe("llm_error");
  });

  it("exports a grouped markdown report", () => {
    const db = openDb(":memory:");
    logFeedback(db, "api_error", "market_not_found: unknown market", { status: 404, requestId: "r1" });
    logFeedback(db, "tool_limitation", "Cannot read region-locked page");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-"));
    const text = fs.readFileSync(exportFeedbackReport(db, dir), "utf8");
    expect(text).toContain("# DelphiLens feedback notes");
    expect(text).toContain("## API errors");
    expect(text).toContain("Context: status=404, requestId=r1");
    expect(text).toContain("## Things the agent could not do");
    expect(text.indexOf("## API errors")).toBeLessThan(text.indexOf("## Things the agent"));
  });

  it("says when there is nothing to report", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-"));
    expect(fs.readFileSync(exportFeedbackReport(openDb(":memory:"), dir), "utf8")).toContain("No issues recorded yet.");
  });
});
