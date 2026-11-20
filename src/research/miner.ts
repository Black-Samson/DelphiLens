import type { DB } from "../db";
import {
  GuardrailError,
  MAX_FILES_PER_SUBMISSION,
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
import { decomposeQuestion } from "./queries";
import type { SearchProvider, SearchResult } from "./search";
import { saveSnapshots } from "./snapshots";
import { isFresh, isPaywalled, rankResults } from "./sources";
import { BriefError, LLMOutputError, mineCandidate, type EvidenceBrief } from "./verifier";

export interface MinerDeps {
  search: SearchProvider;
  llm: LLMProvider;
  fetcher: PageFetcher;
  snapshotsDir: string;
  maxAgeDays: number;
  now?: () => Date;
  onIssue?: (kind: string, detail: string, context?: Record<string, unknown>) => void;
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
export async function findCandidates(market: MarketInfo, deps: MinerDeps, limit = 10): Promise<SearchResult[]> {
  const now = deps.now?.() ?? new Date();
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const query of decomposeQuestion(market)) {
    let results: SearchResult[];
    try {
      results = await deps.search.search(query);
    } catch (err) {
      deps.onIssue?.("search_error", (err as Error).message, { query });
      continue;
    }
    for (const result of results) {
      const key = normalizeUrl(result.url);
      if (seen.has(key) || isPaywalled(result.url)) continue;
      seen.add(key);
      // Undated results stay for now: the page itself may carry a date.
      if (result.published && !isFresh(result.published, market.evidenceCutoff, deps.maxAgeDays, now)) continue;
      merged.push(result);
    }
  }
  return rankResults(merged).slice(0, limit);
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

  let stance = getLockedStance(db, market.marketId);
  const accepted: { result: SearchResult; text: string; evidence: EvidenceBrief }[] = [];

  for (const candidate of await findCandidates(market, deps)) {
    if (accepted.length >= MAX_FILES_PER_SUBMISSION) break;
    if (findDuplicates(db, [candidate.url], "").length) {
      outcome.log.push(`Already used: ${candidate.url}`);
      continue;
    }
    const page = await deps.fetcher.fetch(candidate.url);
    if (!page?.text) {
      outcome.log.push(`Not publicly readable: ${candidate.url}`);
      continue;
    }
    const result = { ...candidate, published: candidate.published ?? page.published };
    if (!isFresh(result.published, market.evidenceCutoff, deps.maxAgeDays, now)) {
      outcome.log.push(`No fresh publication date: ${candidate.url}`);
      continue;
    }

    let mined;
    try {
      mined = await mineCandidate(deps.llm, market, result, page.text);
    } catch (err) {
      if (!(err instanceof LLMOutputError || err instanceof BriefError)) throw err;
      deps.onIssue?.("llm_error", err.message, { url: candidate.url });
      outcome.log.push(`Verification error: ${candidate.url}`);
      continue;
    }
    if (!mined.evidence) {
      outcome.log.push(`Failed checks (${mined.verification.reason}): ${candidate.url}`);
      continue;
    }
    if (stance && mined.evidence.stance !== stance) {
      outcome.log.push(`Skipped ${mined.evidence.stance} evidence: market locked to ${stance}`);
      continue;
    }
    stance = stance ?? mined.evidence.stance;
    accepted.push({ result, text: page.text, evidence: mined.evidence });
  }

  if (!accepted.length || !stance) return outcome;

  const note = accepted[0].evidence.brief;
  const links = accepted.map((a) => a.result.url);
  const files = saveSnapshots(deps.snapshotsDir, market.marketId, accepted);
  const confidence = Math.max(...accepted.map((a) => a.evidence.confidence));
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
