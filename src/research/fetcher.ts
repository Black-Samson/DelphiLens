import * as cheerio from "cheerio";
import { getDocumentProxy } from "unpdf";
import { PUBLIC_API_HOSTS, summarizeReleases } from "./github";
import { describeNetworkError } from "../net";

export const USER_AGENT = "DelphiLens/0.1 (evidence research agent; public sources only)";

export interface FetchedPage {
  text: string;
  /** Publication date found in the page's metadata, if any (ISO 8601). */
  published: string | null;
  /**
   * Set for live machine-readable data (a JSON API such as Wikipedia's siteinfo or
   * nodejs.org/dist/index.json): the values are as of the moment it was read.
   */
  retrievedAt?: string;
}

export const MAX_JSON_CHARS = 12_000;

export interface FetchOptions {
  /**
   * The URL is a data source Delphi itself lists for the market (an API or
   * results page it resolves from). One direct read of it is not crawling,
   * so robots.txt crawl rules (e.g. Wikipedia's "Disallow: /w/") do not apply.
   */
  listedByMarket?: boolean;
}

export interface PageFetcher {
  /** Clean page text, or null when it can't be read publicly. */
  fetch(url: string, options?: FetchOptions): Promise<FetchedPage | null>;
  /** Why the last fetch returned null, when known (e.g. "HTTP 403 (rate limited)"). */
  lastFailure?: string | null;
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
  published ??= validDate($("time[datetime], relative-time[datetime], local-time[datetime]").first().attr("datetime"));

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

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 20;

/** PDF dates look like "D:20261120093000+01'00'". */
export function parsePdfDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = value.match(/D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/);
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", sec = "00", tz = "Z"] = m;
  const zone = tz === "Z" ? "Z" : tz.replace(/'/g, "").replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${sec}${zone}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Text and date of a PDF (official releases, statistics, central bank papers). The judge reads PDFs too. */
export async function extractPdf(bytes: Uint8Array): Promise<FetchedPage | null> {
  if (bytes.byteLength > MAX_PDF_BYTES) return null;
  try {
    const doc = await getDocumentProxy(bytes, { verbosity: 0 });
    const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
    const parts: string[] = [];
    for (let i = 1; i <= pages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      parts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    const meta = (await doc.getMetadata().catch(() => null))?.info as Record<string, unknown> | undefined;
    const text = parts.join("\n").replace(/[ \t]+/g, " ").trim();
    return text ? { text, published: parsePdfDate(meta?.ModDate) ?? parsePdfDate(meta?.CreationDate) } : null;
  } catch {
    return null;
  }
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

  lastFailure: string | null = null;

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
    /** Optional GitHub token: raises GitHub's API limit from 60 to 5,000 requests an hour. */
    private readonly githubToken = "",
  ) {}

  private async get(url: string): Promise<Response | null> {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/pdf,application/json,text/plain;q=0.9",
    };
    if (this.githubToken && url.startsWith("https://api.github.com/")) headers.Authorization = `Bearer ${this.githubToken}`;
    try {
      return await this.fetchFn(url, { headers, redirect: "follow", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      this.lastFailure = describeNetworkError(err);
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

  async fetch(raw: string, options: FetchOptions = {}): Promise<FetchedPage | null> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    this.lastFailure = null;
    const publicApi = PUBLIC_API_HOSTS.includes(url.hostname);
    if (!options.listedByMarket && !publicApi && !(await this.allowed(url))) {
      this.lastFailure = "the site's robots.txt asks automated readers to stay out";
      return null;
    }
    const res = await this.get(url.toString());
    if (!res) return null;
    if (res.status !== 200) {
      const limited =
        res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")
          ? url.hostname === "api.github.com"
            ? " (GitHub's hourly limit for anonymous use; set GITHUB_TOKEN in .env to raise it)"
            : " (rate limited)"
          : res.status === 401 || res.status === 403
            ? " (blocked or needs a login)"
            : "";
      this.lastFailure = `HTTP ${res.status}${limited}`;
      return null;
    }
    const type = res.headers.get("content-type")?.toLowerCase() ?? "";
    if (type.includes("html")) return extractPage(await res.text());
    if (type.includes("pdf") || url.pathname.toLowerCase().endsWith(".pdf")) {
      return extractPdf(new Uint8Array(await res.arrayBuffer()));
    }
    if (type.includes("json")) {
      const raw = await res.text();
      let text = raw;
      try {
        const json = JSON.parse(raw);
        text = summarizeReleases(json) ?? JSON.stringify(json, null, 1);
      } catch {
        /* keep the raw body */
      }
      return { text: text.slice(0, MAX_JSON_CHARS), published: null, retrievedAt: new Date().toISOString() };
    }
    if (type.startsWith("text/")) return { text: (await res.text()).trim(), published: null };
    this.lastFailure = `unsupported content type ${type || "unknown"}`;
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
