import type { MarketInfo } from "../markets/types";
import type { LLMProvider } from "./llm";
import { searchPlan, type SearchQuery } from "./queries";
import { parseJsonObject } from "./verifier";

export const MAX_LLM_QUERIES = 4;

const SYSTEM =
  "You plan web searches for an agent that finds new, dated, public facts about a prediction market. " +
  "Reply with one JSON object and nothing else.";

/**
 * Ask the LLM for extra searches, including ones in the local language: many
 * competition markets resolve from local-language sources (Spanish, German,
 * Japanese, Korean, French...), where facts appear before English coverage.
 */
export async function llmQueries(llm: LLMProvider, market: MarketInfo): Promise<string[]> {
  const prompt = [
    "TASK: QUERIES",
    `QUESTION: ${market.question}`,
    `CATEGORY: ${market.categoryLabel ?? market.category}`,
    `DATA_SOURCES: ${(market.dataSources ?? []).join(", ") || "none listed"}`,
    `RESOLUTION_CRITERIA: ${(market.resolutionCriteria ?? "").replace(/\s+/g, " ").slice(0, 1200)}`,
    `Write up to ${MAX_LLM_QUERIES} short web search queries that would find NEW facts that move this market:`,
    "scheduled releases, official notices, previews, early or partial results, local reporting.",
    "If the market is about a non-English-speaking country, write at least two queries in that country's language.",
    'Reply with JSON: {"queries": ["...", "..."]}',
  ].join("\n");
  const raw = parseJsonObject(await llm.complete(SYSTEM, prompt)).queries;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q): q is string => typeof q === "string")
    .map((q) => q.trim())
    .filter((q) => q.length > 2 && q.length < 200)
    .slice(0, MAX_LLM_QUERIES);
}

/** Template plan plus LLM-written queries (if the LLM can't help, the template plan still runs). */
export async function fullSearchPlan(
  llm: LLMProvider,
  market: MarketInfo,
  onIssue?: (kind: string, detail: string) => void,
): Promise<SearchQuery[]> {
  const plan = searchPlan(market);
  try {
    for (const query of await llmQueries(llm, market)) {
      if (!plan.some((p) => p.query.toLowerCase() === query.toLowerCase())) plan.push({ query });
    }
  } catch (err) {
    onIssue?.("llm_error", `Query planning failed: ${(err as Error).message}`);
  }
  return plan;
}
