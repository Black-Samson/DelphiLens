import { describe, expect, it } from "vitest";
import { extractPage, LiveFetcher, robotsAllows } from "../src/research/fetcher";

const HTML = `<html><head><meta property="article:published_time" content="2026-11-20T08:00:00Z">
<style>p{}</style><script>alert(1)</script></head><body><nav>Menu</nav>
<article><h1>Title</h1><p>First   fact.</p><p>Second fact.</p></article><footer>Copyright</footer></body></html>`;

describe("page extraction", () => {
  it("keeps article text and finds the publication date", () => {
    const page = extractPage(HTML);
    expect(page.published).toBe("2026-11-20T08:00:00.000Z");
    expect(page.text).toBe("Title\nFirst fact.\nSecond fact.");
  });

  it("falls back to <time datetime> and the body", () => {
    const page = extractPage('<body><time datetime="2026-11-19">x</time><div>Plain body text</div></body>');
    expect(page.published).toBe("2026-11-19T00:00:00.000Z");
    expect(page.text).toContain("Plain body text");
  });
});

describe("robots.txt", () => {
  const robots = "User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/press\n";
  it("applies the * group with longest-match wins", () => {
    expect(robotsAllows(robots, "/news/1")).toBe(true);
    expect(robotsAllows(robots, "/private/x")).toBe(false);
    expect(robotsAllows(robots, "/private/press/1")).toBe(true);
    expect(robotsAllows("", "/anything")).toBe(true);
  });
});

describe("live fetcher", () => {
  const fake = (pages: Record<string, Response>) =>
    (async (url: string) => pages[url]?.clone() ?? new Response("nope", { status: 404 })) as unknown as typeof fetch;

  it("reads allowed HTML pages", async () => {
    const fetcher = new LiveFetcher(
      fake({ "https://a.gov/r/1": new Response(HTML, { headers: { "content-type": "text/html" } }) }),
    );
    expect((await fetcher.fetch("https://a.gov/r/1"))?.text).toContain("First fact.");
  });

  it("skips disallowed, missing, non-text and invalid urls", async () => {
    const fetcher = new LiveFetcher(
      fake({
        "https://b.gov/robots.txt": new Response("User-agent: *\nDisallow: /secret"),
        "https://b.gov/secret/1": new Response(HTML, { headers: { "content-type": "text/html" } }),
        "https://b.gov/file.pdf": new Response("%PDF", { headers: { "content-type": "application/pdf" } }),
      }),
    );
    expect(await fetcher.fetch("https://b.gov/secret/1")).toBeNull();
    expect(await fetcher.fetch("https://b.gov/missing")).toBeNull();
    expect(await fetcher.fetch("https://b.gov/file.pdf")).toBeNull();
    expect(await fetcher.fetch("not a url")).toBeNull();
  });
});
