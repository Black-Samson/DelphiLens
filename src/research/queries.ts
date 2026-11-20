import type { MarketInfo } from "../markets/types";

export const MAX_QUERIES = 6;

const LEAD = /^(will|would|does|do|is|are|can|could|has|have|did)\s+/i;
const DEADLINE =
  /\s+(before|by|on|until|in)\s+(the\s+)?(end of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(\s+\d{1,2})?(,?\s+\d{4})?\s*$/i;

/** Extra queries per category that point at primary sources. */
const CATEGORY_QUERIES: Record<string, string[]> = {
  politics: ["{base} official schedule vote", "{base} government press release"],
  economics: ["{base} central bank statement", "{base} statistics bureau release"],
  crypto: ["{base} SEC filing", "{base} GitHub release"],
  technology: ["{base} GitHub release notes", "{base} official announcement blog"],
  sports: ["{base} official team news", "{base} fixture injury report"],
};

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
