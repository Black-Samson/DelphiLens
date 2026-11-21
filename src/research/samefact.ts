import type { LLMProvider } from "./llm";
import { parseJsonObject } from "./verifier";

/**
 * Delphi counts facts, not links: a different URL, quote or language does not
 * make the same fact new, and a repeat earns nothing. Before drafting, each new
 * fact is compared with what was already drafted or sent on the market.
 */
export interface PriorNote {
  id: number;
  note: string;
}

const SYSTEM =
  "You decide whether a new fact is already stated in earlier evidence notes. " +
  "Same event, number or decision counts as the same fact even if worded, sourced or translated differently. " +
  "Reply with one JSON object and nothing else.";

export async function findRepeat(llm: LLMProvider, fact: string, prior: PriorNote[]): Promise<number | null> {
  if (!fact.trim() || !prior.length) return null;
  const prompt = [
    "TASK: SAME_FACT",
    `NEW_FACT: ${fact}`,
    "EARLIER_NOTES:",
    ...prior.map((p) => `[${p.id}] ${p.note.replace(/\s+/g, " ").slice(0, 1200)}`),
    'Reply with JSON: {"same_as": <id of the earlier note that already states this fact, or null>}',
  ].join("\n");
  const raw = parseJsonObject(await llm.complete(SYSTEM, prompt)).same_as;
  const id = Number(raw);
  return raw !== null && raw !== undefined && prior.some((p) => p.id === id) ? id : null;
}

const STOP = new Set(
  "the a an of to in on for and or by at is was were be been has have had it its this that with from as will would".split(" "),
);

export function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\(\d{4}-\d{2}-\d{2}\)/g, " ")
      .split(/[^a-z0-9$%.]+/)
      .map((w) => w.replace(/\.$/, ""))
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** Offline stand-in: most of the new fact's words already appear in one earlier note. */
export function mockSameFact(prompt: string): string {
  const fact = prompt.match(/^NEW_FACT: (.*)$/m)?.[1] ?? "";
  const words = contentWords(fact);
  for (const line of prompt.split("\n")) {
    const m = line.match(/^\[(\d+)\] (.*)$/);
    if (!m || !words.size) continue;
    const earlier = contentWords(m[2]);
    const shared = [...words].filter((w) => earlier.has(w)).length;
    if (shared / words.size >= 0.8) return JSON.stringify({ same_as: Number(m[1]) });
  }
  return JSON.stringify({ same_as: null });
}
