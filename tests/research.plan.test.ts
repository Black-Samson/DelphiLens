import { describe, expect, it } from "vitest";
import { MockLLM, type LLMProvider } from "../src/research/llm";
import { fullSearchPlan, llmQueries } from "../src/research/plan";
import { sampleMarkets } from "../src/markets/mock";

const vox = sampleMarkets(new Date("2026-11-25T18:00:00Z"))[1];

class Scripted implements LLMProvider {
  prompts: string[] = [];
  constructor(private reply: string) {}
  async complete(_s: string, p: string) {
    this.prompts.push(p);
    return this.reply;
  }
}

describe("LLM search planning", () => {
  it("adds local-language queries from the LLM", async () => {
    const llm = new Scripted(
      JSON.stringify({ queries: ["encuesta CIS escaños Vox noviembre 2026", "Vox escaños sondeo", "", 42, "x".repeat(300), "a", "b c", "d e"] }),
    );
    const queries = await llmQueries(llm, vox);
    expect(queries).toEqual(["encuesta CIS escaños Vox noviembre 2026", "Vox escaños sondeo", "b c", "d e"]);
    expect(llm.prompts[0]).toContain("country's language");
    expect(llm.prompts[0]).toContain("infoelectoral.interior.gob.es");
  });

  it("keeps the template plan when the LLM fails or adds nothing", async () => {
    const issues: string[] = [];
    const broken: LLMProvider = { complete: async () => "not json" };
    const plan = await fullSearchPlan(broken, vox, (k) => issues.push(k));
    expect(plan.length).toBeGreaterThan(2);
    expect(issues).toEqual(["llm_error"]);
    expect((await fullSearchPlan(new MockLLM(), vox)).length).toBe(plan.length);
  });

  it("does not repeat a query the template already has", async () => {
    const base = await fullSearchPlan(new MockLLM(), vox);
    const llm = new Scripted(JSON.stringify({ queries: [base[1].query.toUpperCase(), "nueva consulta"] }));
    const plan = await fullSearchPlan(llm, vox);
    expect(plan.length).toBe(base.length + 1);
    expect(plan.at(-1)).toEqual({ query: "nueva consulta" });
  });
});
