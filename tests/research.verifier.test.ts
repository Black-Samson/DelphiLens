import { describe, expect, it } from "vitest";
import { MockLLM } from "../src/research/llm";
import type { LLMProvider } from "../src/research/llm";
import {
  BriefError,
  findQuote,
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
  ])("validates brief %s", (brief, ok) => {
    expect(validateBrief(brief).length === 0).toBe(ok);
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
