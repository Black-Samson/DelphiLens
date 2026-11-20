import { describe, expect, it, vi } from "vitest";
import { MockSearchProvider, TavilySearchProvider } from "../src/research/search";

describe("search providers", () => {
  it("mock returns a mix of fresh, stale, paywalled and undated results", async () => {
    const results = await new MockSearchProvider(new Date("2026-11-24T00:00:00Z")).search("fed rate cut");
    expect(results).toHaveLength(6);
    expect(results.some((r) => r.published === null)).toBe(true);
    expect(results.some((r) => r.url.includes("wsj.com"))).toBe(true);
  });

  it("calls Tavily news search with a freshness window", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          results: [
            { title: "A", url: "https://a.gov/x", content: "c", published_date: "Tue, 18 Nov 2026 10:00:00 GMT" },
            { title: "B", url: "https://b.com/y", content: "c" },
            { title: "no url" },
          ],
        }),
      ),
    );
    const results = await new TavilySearchProvider("key", 7, fetchFn as unknown as typeof fetch).search("q", 5);
    expect(results).toEqual([
      { title: "A", url: "https://a.gov/x", snippet: "c", published: "2026-11-18T10:00:00.000Z" },
      { title: "B", url: "https://b.com/y", snippet: "c", published: null },
    ]);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ query: "q", max_results: 5, topic: "news", days: 7 });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer key");
  });

  it("reports Tavily errors", async () => {
    const fetchFn = async () => new Response("no", { status: 401 });
    await expect(new TavilySearchProvider("bad", 7, fetchFn as unknown as typeof fetch).search("q")).rejects.toThrow(/401/);
  });
});
