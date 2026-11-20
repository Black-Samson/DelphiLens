export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** ISO 8601, or null when the search provider gave no date. */
  published: string | null;
}

export interface SearchProvider {
  search(query: string, maxResults?: number): Promise<SearchResult[]>;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function tag(text: string): string {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

/**
 * Offline search with a realistic mix: fresh primary sources, a stale filing,
 * a paywalled article and an undated blog, so every filter gets exercised.
 */
export class MockSearchProvider implements SearchProvider {
  constructor(private readonly now?: Date) {}

  async search(query: string, maxResults = 10): Promise<SearchResult[]> {
    const now = this.now ?? new Date();
    const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
    const s = slug(query);
    const t = tag(query);
    return [
      { title: `Official notice: ${query}`, url: `https://agency.example.gov/releases/${s}-${t}`, snippet: "Government release.", published: ago(2) },
      { title: `Commit: ${query}`, url: `https://github.com/example-org/tracker/commit/${t}`, snippet: "Repository commit.", published: ago(4) },
      { title: `Local report: ${query}`, url: `https://localnews.example.com/${s}-${t}`, snippet: "Local news.", published: ago(1) },
      { title: `Archived filing: ${query}`, url: `https://agency.example.gov/archive/${s}-${t}`, snippet: "Old filing.", published: ago(90) },
      { title: `Premium analysis: ${query}`, url: `https://www.wsj.com/articles/${s}-${t}`, snippet: "Paywalled.", published: ago(1) },
      { title: `Blog: ${query}`, url: `https://blog.example.com/${s}-${t}`, snippet: "No date.", published: null },
    ].slice(0, maxResults);
  }
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}

/** Tavily web search (https://tavily.com). News topic results carry publication dates. */
export class TavilySearchProvider implements SearchProvider {
  constructor(
    private readonly apiKey: string,
    private readonly maxAgeDays = 14,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async search(query: string, maxResults = 8): Promise<SearchResult[]> {
    const res = await this.fetchFn("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        topic: "news",
        days: this.maxAgeDays,
        search_depth: "basic",
      }),
    });
    if (!res.ok) throw new Error(`Tavily search returned HTTP ${res.status}`);
    const body = (await res.json()) as { results?: TavilyResult[] };
    return (body.results ?? [])
      .filter((r) => r.url)
      .map((r) => {
        const date = r.published_date ? new Date(r.published_date) : null;
        return {
          title: r.title ?? r.url!,
          url: r.url!,
          snippet: r.content ?? "",
          published: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
        };
      });
  }
}
