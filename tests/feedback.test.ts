import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { vi } from "vitest";
import { loadSettings } from "../src/config";
import { classify, exportFeedbackReport, listFeedback, logFeedback, sendFeedback } from "../src/feedback";

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

describe("sending feedback to Delphi", () => {
  const WALLET = "0x" + "b".repeat(40);
  const settings = loadSettings({ DELPHI_API_ACCESS_KEY: "key-1", DELPHI_WALLET: WALLET, AGENT_MODEL: "gpt-4o-mini" });

  it("posts the entry with key, wallet, area and agent headers, then marks it sent", async () => {
    const db = openDb(":memory:");
    logFeedback(db, "api_error", "market_not_found: unknown market", { market: "0xabc", status: 404 });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ id: "fb_1", createdAt: "x" }), { status: 201 }));
    const id = listFeedback(db)[0].id;
    expect(await sendFeedback(db, settings, id, { fetch: fetchFn as unknown as typeof fetch })).toBe("fb_1");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://feedback.delphi.fyi/v1/feedback");
    expect(init.headers).toMatchObject({ "x-api-key": "key-1", "X-Agent-Id": "DelphiLens", "X-Agent-Model": "gpt-4o-mini" });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ wallet: WALLET, area: "api", marketId: "0xabc", topic: "agent-competition-evidence-mining" });
    expect(body.title.length).toBeLessThanOrEqual(120);
    expect(body.text).toContain("Context: market=0xabc, status=404");
    expect(listFeedback(db)[0].sent_id).toBe("fb_1");
    await expect(sendFeedback(db, settings, id, { fetch: fetchFn as unknown as typeof fetch })).rejects.toThrow(/already sent/);
  });

  it("needs the wallet and explains Delphi's refusals", async () => {
    const db = openDb(":memory:");
    logFeedback(db, "note", "Docs do not say which timezone cutoffs use");
    const id = listFeedback(db)[0].id;
    await expect(sendFeedback(db, loadSettings({ DELPHI_API_ACCESS_KEY: "k" }), id)).rejects.toThrow(/DELPHI_WALLET/);
    const refuse = async () => new Response(JSON.stringify({ error: "wallet_mismatch" }), { status: 403 });
    await expect(sendFeedback(db, settings, id, { fetch: refuse as unknown as typeof fetch })).rejects.toThrow(/wallet does not match/);
    expect(listFeedback(db)[0].sent_id).toBeNull();
    await expect(sendFeedback(db, settings, 999)).rejects.toThrow(/No feedback entry/);
  });
});
