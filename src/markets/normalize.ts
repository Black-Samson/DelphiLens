import type { MarketInfo } from "./types";

/**
 * The competition /markets.json format is published on Nov 25. Until then this
 * reads the field names we can reasonably expect and ignores anything else.
 * When the real format is known, adjust the PICK lists below; nothing else changes.
 */
const PICK = {
  id: ["marketAddress", "address", "market_address", "id", "marketId", "market_id"],
  question: ["question", "title", "name"],
  category: ["category", "topic"],
  yesOdds: ["yesOdds", "yes_odds", "yesPrice", "yes_price", "probability", "yesProbability"],
  closeTime: ["closeTime", "close_time", "closesAt", "closes_at", "resolvesAt", "settlesAt"],
  evidenceCutoff: ["evidenceCutoff", "evidence_cutoff", "evidenceDeadline", "cutoff"],
  rewardPot: ["rewardPot", "reward_pot", "pot", "judgementPot", "reward"],
  url: ["url", "marketUrl", "market_url", "link"],
} as const;

type Raw = Record<string, unknown>;

function pick(raw: Raw, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  if (value && typeof value === "object" && "amount" in value) return asNumber((value as Raw).amount);
  return null;
}

function asDate(value: unknown): string | null {
  if (typeof value === "number") return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  const text = asString(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Odds may arrive as 0.62, 62 (percent) or a [yes, no] pair. */
function asOdds(raw: Raw): number | null {
  const pair = raw.spotImpliedProbabilities ?? raw.odds ?? raw.prices;
  if (Array.isArray(pair) && pair.length > 0) return asOdds({ yesOdds: pair[0] });
  const value = asNumber(pick(raw, PICK.yesOdds));
  if (value === null || value < 0) return null;
  const odds = value > 1 ? value / 100 : value;
  return odds <= 1 ? Math.round(odds * 1000) / 1000 : null;
}

export function normalizeMarket(input: unknown): MarketInfo | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Raw;
  const meta = (raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {}) as Raw;
  const marketId = asString(pick(raw, PICK.id));
  const question = asString(pick(raw, PICK.question)) ?? asString(meta.question);
  if (!marketId || !question) return null;
  return {
    marketId,
    question,
    category: (asString(pick(raw, PICK.category)) ?? "other").toLowerCase(),
    yesOdds: asOdds(raw),
    closeTime: asDate(pick(raw, PICK.closeTime)),
    evidenceCutoff: asDate(pick(raw, PICK.evidenceCutoff)),
    rewardPot: asNumber(pick(raw, PICK.rewardPot)) ?? 0,
    url: asString(pick(raw, PICK.url)),
  };
}

/** Accepts a bare array or an object wrapping one (markets, items, data). */
export function normalizeMarketList(payload: unknown): MarketInfo[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? (["markets", "items", "data"].map((k) => (payload as Raw)[k]).find(Array.isArray) ?? [])
      : [];
  return (list as unknown[]).map(normalizeMarket).filter((m): m is MarketInfo => m !== null);
}
