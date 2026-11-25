import type { SearchResult } from "./search";

export type SourceKind = "primary" | "news" | "other";

const PRIMARY_HOSTS = [
  "sec.gov", "federalreserve.gov", "congress.gov", "whitehouse.gov", "europa.eu", "github.com",
  "kernel.org", "cbn.gov.ng", "nigerianstat.gov.ng", "premierleague.com", "uefa.com", "fifa.com",
  "bls.gov", "bea.gov", "treasury.gov", "ecb.europa.eu", "bankofengland.co.uk", "imf.org", "worldbank.org",
];
const PRIMARY_SUFFIXES = [".gov", ".gov.ng", ".gov.uk", ".gouv.fr", ".gc.ca", ".mil", ".int"];
const NEWS_HOSTS = ["reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "aljazeera.com", "punchng.com", "premiumtimesng.com"];
const PAYWALLED_HOSTS = ["wsj.com", "ft.com", "bloomberg.com", "nytimes.com", "economist.com", "barrons.com", "theinformation.com"];

function host(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

const matches = (h: string, list: string[]) => list.some((d) => h === d || h.endsWith(`.${d}`));

/** `extraPrimary` adds hosts that count as primary for one market (its listed data sources). */
export function classifySource(url: string, extraPrimary: string[] = []): SourceKind {
  const h = host(url);
  if (matches(h, PRIMARY_HOSTS) || matches(h, extraPrimary) || PRIMARY_SUFFIXES.some((s) => h.endsWith(s))) return "primary";
  if (matches(h, NEWS_HOSTS)) return "news";
  return "other";
}

/** Competition rule: public information only, so known paywalls are skipped. */
export function isPaywalled(url: string): boolean {
  return matches(host(url), PAYWALLED_HOSTS);
}

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * When the market (and the forecaster's view of it) started, if Delphi says.
 * The resolution criteria count results "published strictly after <time>"; that
 * time is when the market was set up. Facts public before it are presumed priced.
 */
export function marketOpenedAt(resolutionCriteria: string | null | undefined): string | null {
  const match = resolutionCriteria?.match(/strictly after (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
  return match ? (parseDate(match[1])?.toISOString() ?? null) : null;
}

/**
 * Is this publication date inside the fresh window?
 * Fresh means: no older than maxAgeDays, not before `notBefore` (the market's
 * start), not in the future, and not after the evidence cutoff.
 */
export function isFresh(
  published: string | null,
  evidenceCutoff: string | null,
  maxAgeDays: number,
  now = new Date(),
  notBefore: string | null = null,
): boolean {
  const date = parseDate(published);
  if (!date) return false;
  const cutoff = parseDate(evidenceCutoff);
  const latest = cutoff && cutoff < now ? cutoff : now;
  let earliest = new Date(now.getTime() - maxAgeDays * 86_400_000);
  const start = parseDate(notBefore);
  if (start && start > earliest) earliest = start;
  return date >= earliest && date <= latest;
}

const KIND_ORDER: Record<SourceKind, number> = { primary: 0, news: 1, other: 2 };

/** Primary sources first, then newest first. Undated results go last in their group. */
export function rankResults(results: SearchResult[], extraPrimary: string[] = []): SearchResult[] {
  return [...results].sort((a, b) => {
    const kind = KIND_ORDER[classifySource(a.url, extraPrimary)] - KIND_ORDER[classifySource(b.url, extraPrimary)];
    if (kind) return kind;
    return (parseDate(b.published)?.getTime() ?? 0) - (parseDate(a.published)?.getTime() ?? 0);
  });
}
