import { describe, expect, it } from "vitest";
import { extractPage, LiveFetcher } from "../src/research/fetcher";
import { marketRepo, releasesApiUrl, summarizeReleases } from "../src/research/github";

describe("GitHub release markets", () => {
  it("finds the repository from data sources or the question", () => {
    expect(marketRepo({ question: "Q?", dataSources: ["https://github.com/oven-sh/bun/releases"] })).toBe("oven-sh/bun");
    expect(
      marketRepo({ question: "Will oven-sh/bun publish a GitHub release tagged bun-v1.4.6 or later?", dataSources: [] }),
    ).toBe("oven-sh/bun");
    expect(marketRepo({ question: "Will Go 1.27.5 be listed?", dataSources: ["https://go.dev/doc/devel/release"] })).toBeNull();
    expect(releasesApiUrl("oven-sh/bun")).toBe("https://api.github.com/repos/oven-sh/bun/releases?per_page=15");
  });

  it("summarizes releases with dates and the usual gap between them", () => {
    const text = summarizeReleases([
      { tag_name: "bun-v1.4.5", published_at: "2026-11-20T18:00:00Z", html_url: "https://github.com/oven-sh/bun/releases/tag/bun-v1.4.5" },
      { tag_name: "bun-v1.4.4", published_at: "2026-11-13T18:00:00Z" },
      { tag_name: "bun-v1.4.3", published_at: "2026-11-04T18:00:00Z", prerelease: true },
      { tag_name: "draft", draft: true },
    ]);
    expect(text).toContain("bun-v1.4.5 published 2026-11-20T18:00:00Z https://github.com/oven-sh/bun/releases/tag/bun-v1.4.5");
    expect(text).toContain("bun-v1.4.3 (pre-release)");
    expect(text).not.toContain("draft");
    expect(text).toContain("Average gap between the last 3 releases: 8.0 days (shortest 7.0, longest 9.0).");
    expect(summarizeReleases({ not: "a list" })).toBeNull();
  });

  it("reads the releases API even though api.github.com disallows crawlers", async () => {
    const fetchFn = (async (url: string) =>
      url.endsWith("robots.txt")
        ? new Response("User-agent: *\nDisallow: /")
        : new Response(JSON.stringify([{ tag_name: "bun-v1.4.5", published_at: "2026-11-20T18:00:00Z" }]), {
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch;
    const page = await new LiveFetcher(fetchFn).fetch(releasesApiUrl("oven-sh/bun"));
    expect(page?.text).toContain("bun-v1.4.5 published 2026-11-20T18:00:00Z");
    expect(page?.retrievedAt).toBeTruthy();
  });

  it("dates GitHub pages from their relative-time tags", () => {
    expect(extractPage('<body><relative-time datetime="2026-11-20T18:00:00Z">Nov 20</relative-time><p>v1.4.5</p></body>').published).toBe(
      "2026-11-20T18:00:00.000Z",
    );
  });
});
