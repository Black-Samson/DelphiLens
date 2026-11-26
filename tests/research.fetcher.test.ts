import { describe, expect, it } from "vitest";
import { extractPage, extractPdf, LiveFetcher, parsePdfDate, robotsAllows } from "../src/research/fetcher";

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

const PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 51>>stream
BT /F1 12 Tf 20 50 Td (Inflation fell to 2.6 percent) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
6 0 obj<</CreationDate(D:20261126093000+01'00')>>endobj
trailer<</Root 1 0 R/Info 6 0 R>>
%%EOF`;
const pdfBytes = () => new Uint8Array(Buffer.from(PDF, "latin1"));

describe("PDF reading", () => {
  it("extracts text and the creation date", async () => {
    const page = await extractPdf(pdfBytes());
    expect(page?.text).toContain("Inflation fell to 2.6 percent");
    expect(page?.published).toBe("2026-11-26T08:30:00.000Z");
  });

  it("parses PDF dates and rejects junk", async () => {
    expect(parsePdfDate("D:20261120")).toBe("2026-11-20T00:00:00.000Z");
    expect(parsePdfDate("D:20261120093000Z")).toBe("2026-11-20T09:30:00.000Z");
    expect(parsePdfDate("nope")).toBeNull();
    expect(await extractPdf(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("is used by the live fetcher for PDF links", async () => {
    const fetchFn = (async (url: string) =>
      url.endsWith("robots.txt")
        ? new Response("", { status: 404 })
        : new Response(pdfBytes(), { headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch;
    const page = await new LiveFetcher(fetchFn).fetch("https://stats.example.gov/release.pdf");
    expect(page?.text).toContain("2.6 percent");
  });
});
