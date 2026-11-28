import type { MarketInfo } from "../markets/types";

/**
 * Official pages that publish a running count before the outcome is known.
 * They are undated as a whole, but every update carries its own date, so the
 * reading is treated like live data: observed when DelphiLens reads it.
 */
export interface Tracker {
  url: string;
  title: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** First "Nov 29, 2026" / "29 Nov 2026" style date in a question, as YYYYMMDD. */
export function questionDate(question: string): string | null {
  const pad = (n: number) => String(n).padStart(2, "0");
  let m = /\b([A-Z][a-z]{2})[a-z]*\.? (\d{1,2}), (20\d\d)\b/.exec(question);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}${pad(MONTHS[m[1].toLowerCase()])}${pad(Number(m[2]))}`;
  m = /\b(\d{1,2}) ([A-Z][a-z]{2})[a-z]* (20\d\d)\b/.exec(question);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}${pad(MONTHS[m[2].toLowerCase()])}${pad(Number(m[1]))}`;
  return null;
}

export function liveTrackers(market: Pick<MarketInfo, "question">): Tracker[] {
  const q = market.question;
  const trackers: Tracker[] = [];
  // Swiss federal votes: Geneva publishes daily postal-vote turnout ("participation à J-n") before vote day.
  if (/\b(Swiss|Switzerland)\b/i.test(q) && /\b(vote|referendum|turnout)\b/i.test(q)) {
    const date = questionDate(q);
    if (date) trackers.push({ url: `https://www.ge.ch/votations/${date}/`, title: "Canton of Geneva: running turnout before vote day" });
  }
  return trackers;
}
