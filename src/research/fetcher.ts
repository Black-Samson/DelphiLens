import * as cheerio from "cheerio";

export const USER_AGENT = "DelphiLens/0.1 (evidence research agent; public sources only)";

export interface FetchedPage {
  text: string;
  /** Publication date found in the page's metadata, if any (ISO 8601). */
  published: string | null;
}

export interface PageFetcher {
  /** Clean page text, or null when it can't be read publicly. */
  fetch(url: string): Promise<FetchedPage | null>;
}

const DATE_META = [
  'meta[property="article:published_time"]',
  'meta[name="article:published_time"]',
  'meta[name="pubdate"]',
  'meta[name="publish-date"]',
  'meta[name="date"]',
  'meta[name="DC.date.issued"]',
  'meta[itemprop="datePublished"]',
];

function validDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Turn HTML into readable text and find its publication date. */
export function extractPage(html: string): FetchedPage {
  const $ = cheerio.load(html);
  let published: string | null = null;
  for (const selector of DATE_META) {
    published = validDate($(selector).attr("content"));
    if (published) break;
  }
  published ??= validDate($("time[datetime]").first().attr("datetime"));

  $("script, style, noscript, nav, footer, header, aside, form, iframe, svg").remove();
  const root = $("article").first().length ? $("article").first() : $("main").first().length ? $("main").first() : $("body");
  const blocks: string[] = [];
  root.find("h1, h2, h3, p, li, td, pre").each((_, el) => {
    const line = $(el).text().replace(/\s+/g, " ").trim();
    if (line.length > 1) blocks.push(line);
  });
  const text = (blocks.length ? blocks.join("\n") : root.text().replace(/\s+/g, " ")).trim();
  return { text, published };
}

/** Minimal robots.txt check for the "User-agent: *" group. */
export function robotsAllows(robots: string, path: string): boolean {
  let applies = false;
  const disallow: string[] = [];
  const allow: string[] = [];
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (/^user-agent$/i.test(key)) applies = value === "*";
    else if (applies && /^disallow$/i.test(key) && value) disallow.push(value);
    else if (applies && /^allow$/i.test(key) && value) allow.push(value);
  }
  const longest = (rules: string[]) => Math.max(-1, ...rules.filter((r) => path.startsWith(r)).map((r) => r.length));
  return longest(allow) >= longest(disallow);
}

/** Real fetcher. Respects robots.txt and skips anything behind a login or payment. */
export class LiveFetcher implements PageFetcher {
  private robots = new Map<string, string>();

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  private async get(url: string): Promise<Response | null> {
    try {
      return await this.fetchFn(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain;q=0.9" },
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return null;
    }
  }

  private async allowed(url: URL): Promise<boolean> {
    if (!this.robots.has(url.origin)) {
      const res = await this.get(`${url.origin}/robots.txt`);
      this.robots.set(url.origin, res?.ok ? await res.text() : "");
    }
    return robotsAllows(this.robots.get(url.origin) ?? "", url.pathname);
  }

  async fetch(raw: string): Promise<FetchedPage | null> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (!(await this.allowed(url))) return null;
    const res = await this.get(url.toString());
    if (!res || res.status !== 200) return null;
    const type = res.headers.get("content-type")?.toLowerCase() ?? "";
    if (type.includes("html")) return extractPage(await res.text());
    if (type.startsWith("text/")) return { text: (await res.text()).trim(), published: null };
    return null;
  }
}

/** Offline fetcher: believable page text based on the URL. */
export class MockFetcher implements PageFetcher {
  async fetch(url: string): Promise<FetchedPage | null> {
    const parsed = new URL(url);
    const ref = parsed.pathname.split("/").filter(Boolean).pop() ?? "item";
    if (parsed.hostname.includes("localnews")) {
      return { text: `Anonymous sources said the plan was approved in report ${ref}. It could not be confirmed independently.`, published: null };
    }
    if (parsed.hostname.includes("github.com")) {
      return {
        text: `Maintainers merged commit ${ref} into the main branch. The release was scheduled and approved in the public tracker. No other changes are listed.`,
        published: null,
      };
    }
    if (parsed.hostname.includes("blog.example.com")) {
      return { text: `An opinion post about ${ref}. The author expects it to be approved.`, published: new Date().toISOString() };
    }
    return {
      text: `The agency confirmed the measure in release ${ref}. The notice was approved and published on its official website. Markets had not yet adjusted to the announcement.`,
      published: null,
    };
  }
}
