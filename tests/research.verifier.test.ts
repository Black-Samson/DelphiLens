import { describe, expect, it } from "vitest";
import { MockLLM } from "../src/research/llm";
import type { LLMProvider } from "../src/research/llm";
import {
  BriefError,
  findQuote,
  futureClaims,
  LLMOutputError,
  parseJsonObject,
  validateBrief,
  verifyEvidence,
  writeBrief,
} from "../src/research/verifier";
import { sampleMarkets } from "../src/markets/mock";

const market = sampleMarkets(new Date("2026-11-24T00:00:00Z"))[4];
const result = { title: "Fed", url: "https://www.federalreserve.gov/n", snippet: "", published: "2026-11-22T09:00:00Z" };
const GOOD =
  "The Federal Reserve confirmed a rate cut for its December meeting. The statement appeared on its website. Futures had not adjusted.";

class Scripted implements LLMProvider {
  prompts: string[] = [];
  constructor(private replies: string[]) {}
  async complete(_s: string, p: string) {
    this.prompts.push(p);
    return this.replies.shift() ?? "";
  }
}

describe("verifier", () => {
  it("parses JSON wrapped in fences or chatter", () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject('Sure! {"a":1} done')).toEqual({ a: 1 });
    expect(() => parseJsonObject("none")).toThrow(LLMOutputError);
    expect(() => parseJsonObject("{bad}")).toThrow(LLMOutputError);
  });

  it("passes good evidence with a direction", async () => {
    const v = await verifyEvidence(new MockLLM(), market, result, GOOD);
    expect(v).toMatchObject({ passed: true, stance: "YES" });
    const no = await verifyEvidence(new MockLLM(), market, result, "The decision was postponed. The filing was withdrawn.");
    expect(no.stance).toBe("NO");
  });

  it("fails private, unverifiable or directionless text", async () => {
    const llm = new MockLLM();
    expect((await verifyEvidence(llm, market, result, "Subscribe to continue. It was approved.")).passed).toBe(false);
    expect((await verifyEvidence(llm, market, result, "Anonymous sources said it was approved.")).passed).toBe(false);
    expect((await verifyEvidence(llm, market, result, "The committee met on Tuesday.")).passed).toBe(false);
  });

  it("returns the fact and a quote taken word for word from the source", async () => {
    const v = await verifyEvidence(new MockLLM(), market, result, GOOD);
    expect(v.quote).toBe("The Federal Reserve confirmed a rate cut for its December meeting.");
    expect(GOOD).toContain(v.quote!);
    expect(v.fact).toContain("2026-11-22");
  });

  it("drops quotes the source does not contain", () => {
    expect(findQuote(GOOD, "The Federal Reserve confirmed a rate cut for its December meeting.")).toBeTruthy();
    expect(findQuote(GOOD, "the federal reserve   confirmed a rate cut")).toBe("The Federal Reserve confirmed a rate cut");
    expect(findQuote(GOOD, "The Fed announced a surprise hike today.")).toBeNull();
    expect(findQuote(GOOD, "short")).toBeNull();
    expect(findQuote(GOOD, 42)).toBeNull();
  });

  it("gives the LLM the resolution criteria and when the market opened", async () => {
    const llm = new Scripted([JSON.stringify({ publicly_accessible: true, verifiable: true, shifts_probability: false })]);
    const withCriteria = {
      ...market,
      resolutionCriteria: "Yes wins if the rate, published strictly after 2026-11-24T09:17:34.007Z, is 2.8% or higher.",
    };
    await verifyEvidence(llm, withCriteria, result, "x");
    expect(llm.prompts[0]).toContain("MARKET_OPENED: 2026-11-24T09:17:34.007Z");
    expect(llm.prompts[0]).toContain("RESOLUTION_CRITERIA: Yes wins if the rate");
    expect(llm.prompts[0]).toContain("partial progress counts");
    expect(llm.prompts[0]).toMatch(/^NOW: \d{4}-\d{2}-\d{2}T.*has not happened yet/m);
  });

  it("skips facts the forecaster would already know, and treats a missing answer as known", async () => {
    const base = { publicly_accessible: true, verifiable: true, shifts_probability: true, stance: "YES", confidence: 0.8, reason: "Release list." };
    const known = await verifyEvidence(new Scripted([JSON.stringify({ ...base, likely_known: true })]), market, result, "x");
    expect(known.passed).toBe(false);
    expect(known.reason).toMatch(/^Likely already known to the forecaster/);
    const missing = await verifyEvidence(new Scripted([JSON.stringify(base)]), market, result, "x");
    expect(missing.passed).toBe(false);
    const fresh = await verifyEvidence(new Scripted([JSON.stringify({ ...base, likely_known: false })]), market, result, "x");
    expect(fresh.passed).toBe(true);
  });

  it("cleans messy LLM output", async () => {
    const llm = new Scripted([
      JSON.stringify({ publicly_accessible: "false", verifiable: true, shifts_probability: true, stance: "yes", confidence: 5 }),
    ]);
    const v = await verifyEvidence(llm, market, result, "x");
    expect(v).toMatchObject({ publiclyAccessible: false, stance: "YES", confidence: 1, passed: false });
  });

  it.each([
    ["The agency filed the rule. It takes effect Monday.", true],
    ["Only one sentence.", false],
    ["One. Two. Three. Four.", false],
    ["A fact. Another fact!", false],
    ["We think so. It happened.", false],
    ["The count is 7,269,362. It is unlikely to reach the threshold.", false],
    ["The count read 7,269,362 at 00:52 UTC. That is 6,138 short, about 424 per day for 14.5 days.", true],
  ])("validates brief %s", (brief, ok) => {
    expect(validateBrief(brief).length === 0).toBe(ok);
  });

  it("rejects past-tense claims about future dates", () => {
    const now = new Date("2026-11-26T09:30:00Z");
    const bad = "The latest release is bun-v1.4.5 from 2026-11-19. No release has been published after 2026-11-28T00:00:00Z.";
    expect(futureClaims(bad, now)).toEqual(["2026-11-28"]);
    expect(validateBrief(bad, now).join()).toMatch(/2026-11-28: that date is in the future/);
    const ok = "The latest release is bun-v1.4.5, published 2026-11-19. The window from 2026-11-28 to 2026-12-11 remains open.";
    expect(futureClaims(ok, now)).toEqual([]);
    expect(validateBrief(ok, now)).toEqual([]);
  });

  it("retries the brief once with feedback, then gives up", async () => {
    const fixed = new Scripted(['{"brief":"One sentence."}', '{"brief":"First fact. Second fact."}']);
    expect(await writeBrief(fixed, market, [{ result, text: GOOD, fact: "f" }], "YES")).toBe("First fact. Second fact.");
    expect(fixed.prompts[1]).toContain("FIX:");
    const broken = new Scripted(['{"brief":"Bad."}', '{"brief":"Still bad."}']);
    await expect(writeBrief(broken, market, [{ result, text: GOOD, fact: "f" }], "YES")).rejects.toThrow(BriefError);
  });

  it("writes one brief from several sources and labels each one", async () => {
    const llm = new Scripted(['{"brief":"Combined fact one. Combined fact two."}']);
    const other = { ...result, url: "https://www.reuters.com/x" };
    const brief = await writeBrief(
      llm,
      market,
      [
        { result, text: GOOD, fact: "Fed confirmed cut (2026-11-22)." },
        { result: other, text: "Reuters reported the confirmation.", fact: "Reuters reported it." },
      ],
      "YES",
    );
    expect(brief).toBe("Combined fact one. Combined fact two.");
    expect(llm.prompts[0]).toContain("SOURCE 1: https://www.federalreserve.gov/n");
    expect(llm.prompts[0]).toContain("SOURCE 2: https://www.reuters.com/x");
    expect(llm.prompts[0]).toContain("FACT: Reuters reported it.");
    await expect(writeBrief(llm, market, [], "YES")).rejects.toThrow(BriefError);
  });

  it("mock brief summarizes the first source without the header lines", async () => {
    const brief = await writeBrief(new MockLLM(), market, [{ result, text: GOOD, fact: "f" }], "YES");
    expect(brief.startsWith("The Federal Reserve confirmed")).toBe(true);
    expect(brief).not.toContain("SOURCE");
    expect(validateBrief(brief)).toEqual([]);
  });
});
