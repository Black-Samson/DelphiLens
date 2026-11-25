import { describe, expect, it, vi } from "vitest";
import { MockLLM, OpenAICompatibleLLM, splitSentences } from "../src/research/llm";

describe("llm providers", () => {
  it("splits sentences without breaking decimals", () => {
    expect(splitSentences("Rates fell 0.25 points. The vote passed! Next?")).toEqual([
      "Rates fell 0.25 points.",
      "The vote passed!",
      "Next?",
    ]);
  });

  it("calls an OpenAI-compatible endpoint in JSON mode", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] })));
    const llm = new OpenAICompatibleLLM("https://api.example.com/v1", "k", "m", fetchFn as unknown as typeof fetch);
    expect(await llm.complete("sys", "hi")).toBe('{"ok":true}');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "m", temperature: 0, response_format: { type: "json_object" } });
  });

  it("retries without JSON mode when a provider refuses it", async () => {
    let calls = 0;
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = async (_url: string, init: RequestInit) => {
      calls++;
      bodies.push(JSON.parse(init.body as string));
      return calls === 1
        ? new Response('{"error":"response_format json_object is not supported"}', { status: 400 })
        : new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":1}' } }] }));
    };
    const llm = new OpenAICompatibleLLM("u", "k", "m", fetchFn as unknown as typeof fetch);
    expect(await llm.complete("s", "p")).toBe('{"ok":1}');
    expect(bodies[0].response_format).toBeDefined();
    expect(bodies[1].response_format).toBeUndefined();
    await llm.complete("s", "p");
    expect(calls).toBe(3);
  });

  it("surfaces LLM errors", async () => {
    const fetchFn = async () => new Response("quota", { status: 429 });
    await expect(new OpenAICompatibleLLM("u", "k", "m", fetchFn as unknown as typeof fetch).complete("s", "p")).rejects.toThrow(/429/);
  });

  it("mock refuses unknown tasks", async () => {
    await expect(new MockLLM().complete("s", "hello")).rejects.toThrow(/unknown task/);
  });
});
