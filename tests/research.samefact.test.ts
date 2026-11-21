import { describe, expect, it } from "vitest";
import { MockLLM, type LLMProvider } from "../src/research/llm";
import { contentWords, findRepeat } from "../src/research/samefact";

const prior = [
  { id: 4, note: "The Federal Reserve confirmed a December rate cut on 22 November. Futures had not priced it in." },
  { id: 7, note: "Nigeria's statistics bureau published October inflation of 21.9% on 15 November." },
];

describe("same-fact check", () => {
  it("spots a repeated fact worded differently (mock)", async () => {
    expect(await findRepeat(new MockLLM(), "Federal Reserve confirmed December rate cut (2026-11-22).", prior)).toBe(4);
    expect(await findRepeat(new MockLLM(), "The Senate scheduled a vote on the bill for 3 December.", prior)).toBeNull();
  });

  it("skips the call when there is nothing to compare", async () => {
    const never: LLMProvider = { complete: async () => Promise.reject(new Error("should not be called")) };
    expect(await findRepeat(never, "Some fact.", [])).toBeNull();
    expect(await findRepeat(never, "  ", prior)).toBeNull();
  });

  it("ignores ids the LLM invents", async () => {
    const llm: LLMProvider = { complete: async () => '{"same_as": 99}' };
    expect(await findRepeat(llm, "Some fact.", prior)).toBeNull();
    const ok: LLMProvider = { complete: async () => '{"same_as": "7"}' };
    expect(await findRepeat(ok, "Some fact.", prior)).toBe(7);
  });

  it("compares meaningful words only", () => {
    expect(contentWords("The Fed cut rates by 0.25% (2026-11-22).")).toEqual(new Set(["fed", "cut", "rates", "0.25%"]));
  });
});
