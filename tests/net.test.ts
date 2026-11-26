import { describe, expect, it } from "vitest";
import { describeNetworkError, fetchFrom, NetworkError } from "../src/net";
import { OpenAICompatibleLLM } from "../src/research/llm";

const failing = (code: string) =>
  (async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`getaddrinfo ${code}`), { code }) });
  }) as unknown as typeof fetch;

describe("network errors", () => {
  it("names the service, the host and the real reason", async () => {
    await expect(fetchFrom("Tavily search", "https://api.tavily.com/search", {}, failing("ENOTFOUND"))).rejects.toThrow(
      "Could not reach Tavily search at https://api.tavily.com: address not found (check the URL for typos, and your internet connection) [ENOTFOUND]",
    );
  });

  it("explains a wrong AI address instead of 'fetch failed'", async () => {
    const llm = new OpenAICompatibleLLM("https://generativelanguage.googleapi.com/v1beta/openai", "k", "m", failing("ENOTFOUND"));
    const err = await llm.complete("s", "p").catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.message).toMatch(/the AI service \(LLM_BASE_URL\) at https:\/\/generativelanguage\.googleapi\.com: address not found/);
  });

  it("describes timeouts and unknown errors", () => {
    expect(describeNetworkError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("the request timed out");
    expect(describeNetworkError(new Error("weird"))).toBe("weird");
  });

  it("names the AI when its answer is cut off mid-way", async () => {
    const aborted = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
          },
        }),
      )) as unknown as typeof fetch;
    const err = await new OpenAICompatibleLLM("https://api.groq.com/openai/v1", "k", "m", aborted).complete("s", "p").catch((e) => e);
    expect(err.message).toBe("Could not reach the AI service (LLM_BASE_URL) at https://api.groq.com/openai/v1: the request timed out");
  });
});
