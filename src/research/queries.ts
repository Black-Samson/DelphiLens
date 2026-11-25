import type { MarketInfo } from "../markets/types";

export const MAX_QUERIES = 6;

const LEAD = /^(will|would|does|do|is|are|can|could|has|have|did)\s+/i;
const DEADLINE =
  /\s+(before|by|on|until|in)\s+(the\s+)?(end of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(\s+\d{1,2})?(,?\s+\d{4})?\s*$/i;

/** Extra queries per competition category that point at primary sources. */
const CATEGORY_QUERIES: Record<string, string[]> = {
  votes_government: ["{base} official schedule vote", "{base} poll survey latest"],
  local_language: ["{base} official announcement", "{base} local press"],
  official_statistics: ["{base} flash estimate state data", "{base} economists forecast consensus"],
  releases_standards: ["{base} changelog release candidate", "{base} mailing list"],
  niche_communities: ["{base} community forum update", "{base} latest results"],
  controls: ["{base} central bank speech", "{base} economists preview"],
  // Older names, kept for markets from other sources.
  politics: ["{base} official schedule vote", "{base} government press release"],
  economics: ["{base} central bank statement", "{base} statistics bureau release"],
  crypto: ["{base} SEC filing", "{base} GitHub release"],
  technology: ["{base} GitHub release notes", "{base} official announcement blog"],
  sports: ["{base} official team news", "{base} fixture injury report"],
};

export interface SearchQuery {
  query: string;
  /** Restrict to these hosts (the market's official data sources). */
  domains?: string[];
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Hosts of the market's listed data sources, minus big wire services (searched anyway). */
export function dataSourceHosts(market: Pick<MarketInfo, "dataSources">): string[] {
  const wires = new Set(["reuters.com", "apnews.com", "bloomberg.com"]);
  const hosts = (market.dataSources ?? []).map(hostOf).filter((h): h is string => Boolean(h) && !wires.has(h!));
  return [...new Set(hosts)];
}

/**
 * The search plan for a market: first the market's own official data sources
 * (where the resolving fact will appear), then general primary-source queries.
 */
export function searchPlan(market: Pick<MarketInfo, "question" | "category" | "dataSources">): SearchQuery[] {
  const plan: SearchQuery[] = [];
  const hosts = dataSourceHosts(market);
  if (hosts.length) plan.push({ query: coreTopic(market.question), domains: hosts });
  for (const query of decomposeQuestion(market)) plan.push({ query });
  return plan.slice(0, MAX_QUERIES + 1);
}

/** The question with its lead verb and trailing deadline removed. */
export function coreTopic(question: string): string {
  return question.trim().replace(/\?+$/, "").replace(LEAD, "").replace(DEADLINE, "").trim();
}

/** Turn a market question into targeted, primary-source-first search queries. */
export function decomposeQuestion(market: Pick<MarketInfo, "question" | "category">): string[] {
  const base = coreTopic(market.question);
  const templates = [
    "{base}",
    "{base} official announcement",
    ...(CATEGORY_QUERIES[market.category] ?? []),
    "{base} latest news",
  ];
  const queries: string[] = [];
  for (const template of templates) {
    const query = template.replace("{base}", base);
    if (!queries.includes(query)) queries.push(query);
  }
  return queries.slice(0, MAX_QUERIES);
}
