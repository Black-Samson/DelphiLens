import type { DB } from "../db";
import {
  GuardrailError,
  MAX_SOURCES_PER_SUBMISSION,
  MAX_SUBMISSIONS_PER_MARKET,
  countSubmissions,
  createDraft,
  findDuplicates,
  getLockedStance,
  type Stance,
} from "../guardrails";
import { normalizeUrl } from "../hashing";
import type { MarketInfo } from "../markets/types";
import type { PageFetcher } from "./fetcher";
import type { LLMProvider } from "./llm";
import { fullSearchPlan } from "./plan";
import { marketRepo, releasesApiUrl } from "./github";
import { dataSourceHosts } from "./queries";
import type { SearchProvider, SearchResult } from "./search";
import { saveSnapshots } from "./snapshots";
import { isFresh, isPaywalled, marketOpenedAt, rankResults } from "./sources";
import { composeNote } from "./note";
import { findRepeat, type PriorNote } from "./samefact";
import { BriefError, LLMOutputError, verifyEvidence, writeBrief, type Verification } from "./verifier";

/** How much stronger one side's evidence must be before DelphiLens commits to it. */
export const STANCE_MARGIN = 1.5;
/** Candidate sources checked per market before deciding. */
export const MAX_EXAMINED = 14;

export interface StanceDecision {
  stance: Stance | null;
  yes: number;
  no: number;
  reason: string;
}

/**
 * Weigh all passing evidence before choosing a side. The settlement reward only
 * pays when the evidence pointed toward the real outcome, and a market's side
 * cannot be changed later, so a lopsided picture is required: one side must
 * outweigh the other by STANCE_MARGIN (confidence-weighted).
 */
export function decideStance(items: { stance: Stance | null; confidence: number }[]): StanceDecision {
  const weigh = (side: Stance) =>
    items.filter((i) => i.stance === side).reduce((sum, i) => sum + Math.max(0.05, i.confidence), 0);
  const yes = Math.round(weigh("YES") * 100) / 100;
  const no = Math.round(weigh("NO") * 100) / 100;
  if (!yes && !no) return { stance: null, yes, no, reason: "No directional evidence" };
  if (yes >= no * STANCE_MARGIN) return { stance: "YES", yes, no, reason: `YES evidence outweighs NO (${yes} vs ${no})` };
  if (no >= yes * STANCE_MARGIN) return { stance: "NO", yes, no, reason: `NO evidence outweighs YES (${no} vs ${yes})` };
  return { stance: null, yes, no, reason: `Evidence is mixed (YES ${yes} vs NO ${no}); not taking a side` };
}

export interface MinerDeps {
  search: SearchProvider;
  llm: LLMProvider;
  fetcher: PageFetcher;
  snapshotsDir: string;
  maxAgeDays: number;
  now?: () => Date;
  onIssue?: (kind: string, detail: string, context?: Record<string, unknown>) => void;
  /** Live progress lines (the CLI prints them as mining runs). */
  onProgress?: (line: string) => void;
}

export interface MiningOutcome {
  marketId: string;
  status: "draft_created" | "no_evidence" | "blocked";
  submissionId: number | null;
  stance: Stance | null;
  note: string;
  links: string[];
  files: string[];
  log: string[];
}

/** Search every query, drop paywalls and duplicates, keep fresh or undated results, rank them. */
export interface SearchStats {
  queries: number;
  failed: number;
  firstError: string | null;
  results: number;
  paywalled: number;
  tooOld: number;
  kept: number;
}

/** Search every planned query, drop paywalls and duplicates, keep fresh or undated results, rank them. */
export async function findCandidates(
  market: MarketInfo,
  deps: MinerDeps,
  limit = 10,
  stats?: SearchStats,
): Promise<SearchResult[]> {
  const now = deps.now?.() ?? new Date();
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  const st: SearchStats = stats ?? { queries: 0, failed: 0, firstError: null, results: 0, paywalled: 0, tooOld: 0, kept: 0 };
  const opened = marketOpenedAt(market.resolutionCriteria);
  deps.onProgress?.("Planning searches...");
  const plan = await fullSearchPlan(deps.llm, market, deps.onIssue);
  for (const { query, domains } of plan) {
    st.queries++;
    deps.onProgress?.(`Searching ${st.queries}/${plan.length}: ${query}${domains ? ` (on ${domains.join(", ")})` : ""}`);
    let results: SearchResult[];
    try {
      results = await deps.search.search(query, undefined, domains ? { domains } : undefined);
    } catch (err) {
      st.failed++;
      st.firstError ??= (err as Error).message;
      deps.onIssue?.("search_error", (err as Error).message, { query });
      continue;
    }
    for (const result of results) {
      const key = normalizeUrl(result.url);
      if (seen.has(key)) continue;
      seen.add(key);
      st.results++;
      if (isPaywalled(result.url)) {
        st.paywalled++;
        continue;
      }
      // Undated results stay for now: the page itself may carry a date.
      if (result.published && !isFresh(result.published, market.evidenceCutoff, deps.maxAgeDays, now, opened)) {
        st.tooOld++;
        continue;
      }
      merged.push(result);
    }
  }
  st.kept = merged.length;
  // The market's listed data sources are where the answer will appear: always check them directly, first.
  const repo = marketRepo(market);
  const direct = [...(repo ? [releasesApiUrl(repo)] : []), ...(market.dataSources ?? [])]
    .filter((url, i, all) => all.indexOf(url) === i && !seen.has(normalizeUrl(url)) && !isPaywalled(url))
    .map((url) => ({
      title: url.includes("api.github.com") ? `GitHub releases of ${repo}` : "Official data source listed by the market",
      url,
      snippet: "",
      published: null,
    }));
  return [...direct, ...rankResults(merged, dataSourceHosts(market))].slice(0, limit + direct.length);
}

export function describeSearch(st: SearchStats, opened: string | null): string {
  const parts = [`${st.queries} searches`];
  if (st.failed) parts.push(`${st.failed} failed (${st.firstError})`);
  parts.push(`${st.results} distinct results`);
  if (st.paywalled) parts.push(`${st.paywalled} paywalled`);
  if (st.tooOld) parts.push(`${st.tooOld} published before ${opened ? `the market opened (${opened.slice(0, 16).replace("T", " ")} UTC)` : "the freshness window"}`);
  parts.push(`${st.kept} kept to check`);
  return `Search: ${parts.join(", ")}`;
}

/** Find the best fresh evidence for one market and queue it as a draft. */
export async function mineMarket(db: DB, market: MarketInfo, deps: MinerDeps): Promise<MiningOutcome> {
  const now = deps.now?.() ?? new Date();
  const outcome: MiningOutcome = {
    marketId: market.marketId,
    status: "no_evidence",
    submissionId: null,
    stance: null,
    note: "",
    links: [],
    files: [],
    log: [],
  };

  if (countSubmissions(db, market.marketId) >= MAX_SUBMISSIONS_PER_MARKET) {
    outcome.status = "blocked";
    outcome.log.push(`Max ${MAX_SUBMISSIONS_PER_MARKET} submissions reached`);
    return outcome;
  }

  const locked = getLockedStance(db, market.marketId);
  const prior = db
    .prepare("SELECT id, note FROM submissions WHERE market_id = ? AND status != 'discarded' ORDER BY id")
    .all(market.marketId) as PriorNote[];
  const passing: { result: SearchResult; text: string; verification: Verification; live: boolean }[] = [];

  const searchStats: SearchStats = { queries: 0, failed: 0, firstError: null, results: 0, paywalled: 0, tooOld: 0, kept: 0 };
  const candidates = await findCandidates(market, deps, 10, searchStats);
  outcome.log.push(describeSearch(searchStats, marketOpenedAt(market.resolutionCriteria)));
  deps.onProgress?.(describeSearch(searchStats, marketOpenedAt(market.resolutionCriteria)));
  let checked = 0;
  for (const candidate of candidates.slice(0, MAX_EXAMINED)) {
    checked++;
    deps.onProgress?.(`Checking source ${checked}/${Math.min(candidates.length, MAX_EXAMINED)}: ${candidate.url}`);
    if (findDuplicates(db, [candidate.url], "").length) {
      outcome.log.push(`Already used: ${candidate.url}`);
      continue;
    }
    const listed = (market.dataSources ?? []).includes(candidate.url) || candidate.url.startsWith("https://api.github.com/");
    const page = await deps.fetcher.fetch(candidate.url, listed ? { listedByMarket: true } : undefined);
    if (!page?.text) {
      outcome.log.push(`Not publicly readable: ${candidate.url}`);
      continue;
    }
    // Live data (a JSON API) is dated by when it was read: that is when the fact was observed.
    const result = { ...candidate, published: candidate.published ?? page.published ?? page.retrievedAt ?? null };
    const checkTime = page.retrievedAt ? new Date(Math.max(Date.parse(page.retrievedAt), now.getTime())) : now;
    if (!isFresh(result.published, market.evidenceCutoff, deps.maxAgeDays, checkTime, marketOpenedAt(market.resolutionCriteria))) {
      outcome.log.push(`Not new since the market opened (or undated): ${candidate.url}`);
      continue;
    }

    let verification: Verification;
    try {
      verification = await verifyEvidence(deps.llm, market, result, page.text);
    } catch (err) {
      if (!(err instanceof LLMOutputError)) throw err;
      deps.onIssue?.("llm_error", err.message, { url: candidate.url });
      outcome.log.push(`Verification error: ${candidate.url}`);
      continue;
    }
    if (!verification.passed || !verification.stance) {
      outcome.log.push(`Failed checks (${verification.reason}): ${candidate.url}`);
      continue;
    }
    try {
      const repeat = await findRepeat(deps.llm, verification.fact || verification.quote || "", prior);
      if (repeat !== null) {
        outcome.log.push(`Same fact as submission #${repeat}: ${candidate.url}`);
        continue;
      }
    } catch (err) {
      if (!(err instanceof LLMOutputError)) throw err;
      deps.onIssue?.("llm_error", `Same-fact check failed: ${err.message}`, { url: candidate.url });
    }
    passing.push({ result, text: page.text, verification, live: Boolean(page.retrievedAt && !candidate.published && !page.published) });
  }

  let stance: Stance | null = locked;
  if (!locked) {
    const decision = decideStance(passing.map((p) => p.verification));
    outcome.log.push(decision.reason);
    stance = decision.stance;
  }
  for (const p of passing) {
    if (stance && p.verification.stance !== stance) {
      outcome.log.push(`Skipped ${p.verification.stance} evidence: ${locked ? `market locked to ${stance}` : `leaning ${stance}`}`);
    }
  }
  // Primary sources were ranked first; within the chosen side keep the order, then the most confident.
  const accepted = passing
    .filter((p) => stance && p.verification.stance === stance)
    .slice(0, MAX_SOURCES_PER_SUBMISSION);
  if (!accepted.length || !stance) return outcome;

  deps.onProgress?.(`Writing the note from ${accepted.length} source(s)...`);
  let brief: string;
  try {
    brief = await writeBrief(
      deps.llm,
      market,
      accepted.map((a) => ({ result: a.result, text: a.text, fact: a.verification.fact })),
      stance,
    );
  } catch (err) {
    if (!(err instanceof LLMOutputError || err instanceof BriefError)) throw err;
    deps.onIssue?.("llm_error", err.message, { market: market.marketId });
    outcome.log.push(`Could not write a note: ${err.message}`);
    return outcome;
  }
  const note = composeNote(
    brief,
    accepted.map((a) => ({ url: a.result.url, published: a.result.published, quote: a.verification.quote, live: a.live })),
  );
  const links = accepted.map((a) => a.result.url);
  const files = saveSnapshots(deps.snapshotsDir, market.marketId, accepted);
  const confidence = Math.max(...accepted.map((a) => a.verification.confidence));
  try {
    outcome.submissionId = createDraft(db, { marketId: market.marketId, stance, note, links, files, confidence });
  } catch (err) {
    if (!(err instanceof GuardrailError)) throw err;
    outcome.status = "blocked";
    outcome.log.push(...err.reasons);
    return outcome;
  }
  Object.assign(outcome, { status: "draft_created", stance, note, links, files });
  return outcome;
}
