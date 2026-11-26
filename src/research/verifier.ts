import { isStance, type Stance } from "../guardrails";
import type { MarketInfo } from "../markets/types";
import { splitSentences, type LLMProvider } from "./llm";
import type { SearchResult } from "./search";
import { marketOpenedAt } from "./sources";

export const MAX_BRIEF_CHARS = 700;
const MAX_TEXT_CHARS = 6000;

const VERIFY_SYSTEM =
  "You are a strict evidence checker for a prediction-market evidence competition. " +
  "Only public information counts. Reply with one JSON object and nothing else.";
const BRIEF_SYSTEM =
  "You write crisp, objective evidence notes for a forecaster. Never invent facts. " +
  "Reply with one JSON object and nothing else.";

export class LLMOutputError extends Error {}
export class BriefError extends Error {}

export interface Verification {
  publiclyAccessible: boolean;
  verifiable: boolean;
  shiftsProbability: boolean;
  stance: Stance | null;
  confidence: number;
  reason: string;
  /** The fact in one plain sentence, used to spot repeats. */
  fact: string;
  /** A sentence copied word for word from the source, or null if the LLM's quote was not found in it. */
  quote: string | null;
  passed: boolean;
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  const cleaned = raw.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new LLMOutputError("No JSON object in LLM reply");
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    throw new LLMOutputError(`Invalid JSON from LLM: ${(err as Error).message}`);
  }
}

const asBool = (v: unknown) => (typeof v === "string" ? ["true", "yes", "1"].includes(v.trim().toLowerCase()) : Boolean(v));

const MAX_CRITERIA_CHARS = 1500;

function header(task: string, market: MarketInfo, result: SearchResult): string {
  const lines = [
    `TASK: ${task}`,
    `QUESTION: ${market.question}`,
    `CURRENT_YES_ODDS: ${market.yesOdds ?? "unknown"}`,
    `EVIDENCE_CUTOFF: ${market.evidenceCutoff ?? "unknown"}`,
  ];
  const opened = marketOpenedAt(market.resolutionCriteria);
  if (opened) lines.push(`MARKET_OPENED: ${opened} (facts public before this are presumed already priced)`);
  if (market.resolutionCriteria) {
    lines.push(`RESOLUTION_CRITERIA: ${market.resolutionCriteria.replace(/\s+/g, " ").slice(0, MAX_CRITERIA_CHARS)}`);
  }
  lines.push(`SOURCE_URL: ${result.url}`, `PUBLISHED: ${result.published ?? ""}`);
  return lines.join("\n");
}

const squash = (t: string) => t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();

/**
 * Keep the LLM's quote only if it really appears in the source text, so a note
 * never puts invented words in quotation marks. Returns the source's own wording.
 */
export function findQuote(text: string, quote: unknown): string | null {
  if (typeof quote !== "string") return null;
  const wanted = squash(quote).replace(/^["']|["']$/g, "");
  if (wanted.length < 12) return null;
  const haystack = squash(text);
  const at = haystack.toLowerCase().indexOf(wanted.toLowerCase());
  return at === -1 ? null : haystack.slice(at, at + wanted.length);
}

export async function verifyEvidence(llm: LLMProvider, market: MarketInfo, result: SearchResult, text: string): Promise<Verification> {
  const prompt = [
    header("VERIFY", market, result),
    "Check three things about the TEXT:",
    "1. publicly_accessible: readable by anyone, no paywall, no confidential, leaked or private personal data.",
    "2. verifiable: a specific, dated fact that can be checked in the source (not rumor or opinion).",
    "3. shifts_probability: new information that should move the probability of the question resolving YES",
    "   under the RESOLUTION_CRITERIA, beyond what the current odds already reflect. It does NOT have to settle",
    "   the question: partial progress counts. Results so far, current standings or scores, early or partial",
    "   figures, official schedules, previews and leading indicators all move the probability.",
    "   Example: for 'will X lead after game 8', the result of game 2 shifts the probability.",
    "   For a numeric threshold with a deadline (a count, a price, a rate), a value that is still moving is",
    "   not evidence by itself: below the threshold today is not NO if normal growth would reach it in time.",
    "   Give a stance only when the TEXT shows the trend or rate, or the gap clearly cannot (or surely will)",
    "   be closed in the time left. Otherwise set shifts_probability false.",
    "   Facts that were public before MARKET_OPENED, opinions and predictions do not count.",
    'Reply with JSON keys: publicly_accessible (bool), verifiable (bool), shifts_probability (bool),',
    'stance ("YES" if it makes YES more likely than the current odds, "NO" if less likely, or null), confidence (0 to 1),',
    "reason (one sentence),",
    "fact (the fact in one plain sentence, with its date), and quote (the single sentence from the TEXT that states",
    "the fact, copied exactly, word for word).",
    "TEXT:",
    text.slice(0, MAX_TEXT_CHARS),
  ].join("\n");
  const data = parseJsonObject(await llm.complete(VERIFY_SYSTEM, prompt));
  const rawStance = typeof data.stance === "string" ? data.stance.trim().toUpperCase() : null;
  const stance = isStance(rawStance) ? rawStance : null;
  const confidence = Math.max(0, Math.min(1, Number(data.confidence) || 0));
  const v = {
    publiclyAccessible: asBool(data.publicly_accessible),
    verifiable: asBool(data.verifiable),
    shiftsProbability: asBool(data.shifts_probability),
    stance,
    confidence,
    reason: String(data.reason ?? ""),
    fact: String(data.fact ?? "").trim(),
    quote: findQuote(text, data.quote),
  };
  return { ...v, passed: v.publiclyAccessible && v.verifiable && v.shiftsProbability && stance !== null };
}

/** Brief rules: 2 or 3 sentences, short, factual, no first person, no hype. */
export function validateBrief(brief: string): string[] {
  const problems: string[] = [];
  const n = splitSentences(brief).length;
  if (n < 2 || n > 3) problems.push(`Brief must be 2-3 sentences, got ${n}`);
  if (brief.length > MAX_BRIEF_CHARS) problems.push(`Brief must be under ${MAX_BRIEF_CHARS} characters`);
  if (brief.includes("!")) problems.push("No exclamation marks");
  if (/\b(I (think|believe|feel|expect)|we|our|my)\b/i.test(brief)) problems.push("No first person or opinions");
  if (/\b(unlikely|likely|probably|expected to|is set to|bound to|almost certainly|indicating that .* will)\b/i.test(brief)) {
    problems.push(
      "No predictions or likelihood words (likely, unlikely, probably...): state facts and the measurable gap to the threshold, and let the forecaster judge",
    );
  }
  return problems;
}

export interface BriefSource {
  result: SearchResult;
  text: string;
  fact: string;
}

/** One 2 to 3 sentence summary written from every chosen source together. */
export async function writeBrief(
  llm: LLMProvider,
  market: MarketInfo,
  sources: BriefSource[],
  stance: Stance,
  retries = 1,
): Promise<string> {
  if (!sources.length) throw new BriefError("No sources to summarize");
  const share = Math.floor(MAX_TEXT_CHARS / sources.length);
  const body = sources
    .map((s, i) => `SOURCE ${i + 1}: ${s.result.url} (published ${s.result.published ?? "unknown"})\nFACT: ${s.fact}\n${s.text.slice(0, share)}`)
    .join("\n\n");
  let feedback = "";
  let problems: string[] = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    const prompt = [
      header("BRIEF", market, sources[0].result),
      `STANCE: ${stance}`,
      `Write a 2 to 3 sentence note for the forecaster that combines the ${sources.length} source(s) below:`,
      "state the dated facts, name who published them, and say how they bear on the question.",
      "Use only facts from the sources. Objective, specific, no opinions, no first person, and no predictions",
      "(never write likely, unlikely or probably: the forecaster judges likelihood).",
      "If the question has a numeric threshold and a deadline, give the measurable gap instead: the current value,",
      "the threshold, the difference, the time left and the average rate per day needed. Do the arithmetic carefully.",
      "For live data read from an API or data page, say 'as read at <time> UTC', not 'published'.",
      'Reply with JSON: {"brief": "..."}',
      feedback,
      "TEXT:",
      body,
    ].join("\n");
    const brief = String(parseJsonObject(await llm.complete(BRIEF_SYSTEM, prompt)).brief ?? "").trim();
    problems = validateBrief(brief);
    if (!problems.length) return brief;
    feedback = `FIX: ${problems.join("; ")}`;
  }
  throw new BriefError(problems.join("; "));
}
