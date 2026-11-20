import { describe, expect, it } from "vitest";
import { MockLLM } from "../src/research/llm";
import type { LLMProvider } from "../src/research/llm";
import {
  BriefError,
  LLMOutputError,
  mineCandidate,
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
    expect(await writeBrief(fixed, market, result, GOOD, "YES")).toBe("First fact. Second fact.");
    expect(fixed.prompts[1]).toContain("FIX:");
    const broken = new Scripted(['{"brief":"Bad."}', '{"brief":"Still bad."}']);
    await expect(writeBrief(broken, market, result, GOOD, "YES")).rejects.toThrow(BriefError);
  });

  it("builds a brief only for evidence that passes", async () => {
    const good = await mineCandidate(new MockLLM(), market, result, GOOD);
    expect(good.evidence).toMatchObject({ stance: "YES", sourceUrl: result.url, marketId: market.marketId });
    const bad = await mineCandidate(new MockLLM(), market, result, "The committee met.");
    expect(bad.evidence).toBeNull();
  });
});
