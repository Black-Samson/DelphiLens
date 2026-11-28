import type { DB } from "../db";
import { normalizeUrl } from "../hashing";

/**
 * Live data (a JSON API) only shows a value, not where it is heading. DelphiLens
 * keeps each reading so the next run can report the change and the pace,
 * e.g. "articles: 7,270,308 → 7,272,100 (+1,792 in 36.0 h, about 1,195 per day)".
 */

/** Readings closer together than this are too noisy to give a pace. */
export const MIN_READING_GAP_HOURS = 3;
const MAX_LINES = 12;

/** Flatten a JSON value to numeric leaves keyed by path ("query.statistics.articles"). */
export function numericLeaves(value: unknown, prefix = "", out = new Map<string, number>()): Map<string, number> {
  if (out.size > 2000) return out;
  if (typeof value === "number" && Number.isFinite(value)) out.set(prefix, value);
  else if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim()) && prefix) out.set(prefix, Number(value));
  else if (Array.isArray(value)) value.slice(0, 50).forEach((v, i) => numericLeaves(v, `${prefix}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) numericLeaves(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Lines describing how numeric values changed between two readings, with the pace per day. */
export function compareReadings(prevBody: string, prevAt: string, body: string, readAt: string): string[] {
  const before = parse(prevBody);
  const after = parse(body);
  if (before === null || after === null) return [];
  const hours = (Date.parse(readAt) - Date.parse(prevAt)) / 3_600_000;
  if (!(hours >= MIN_READING_GAP_HOURS)) return [];
  const old = numericLeaves(before);
  const lines: string[] = [];
  for (const [path, value] of numericLeaves(after)) {
    const was = old.get(path);
    if (was === undefined || was === value) continue;
    const delta = value - was;
    const perDay = (delta / hours) * 24;
    lines.push(
      `${path}: ${fmt(was)} → ${fmt(value)} (${delta > 0 ? "+" : ""}${fmt(delta)} in ${hours.toFixed(1)} h, about ${fmt(perDay)} per day)`,
    );
    if (lines.length >= MAX_LINES) break;
  }
  return lines;
}

/** The oldest-useful earlier reading: the latest one at least MIN_READING_GAP_HOURS before now. */
export function previousReading(db: DB, url: string, readAt: string): { body: string; readAt: string } | null {
  const cutoff = new Date(Date.parse(readAt) - MIN_READING_GAP_HOURS * 3_600_000).toISOString();
  const row = db
    .prepare("SELECT body, read_at FROM live_readings WHERE url = ? AND read_at <= ? ORDER BY read_at DESC LIMIT 1")
    .get(normalizeUrl(url), cutoff) as { body: string; read_at: string } | undefined;
  return row ? { body: row.body, readAt: row.read_at } : null;
}

export function saveReading(db: DB, url: string, readAt: string, body: string): void {
  db.prepare("INSERT OR IGNORE INTO live_readings (url, read_at, body) VALUES (?, ?, ?)").run(normalizeUrl(url), readAt, body);
}

/** Text for the AI checker: the earlier reading and the change since, or nothing if there is no usable one. */
export function trendNote(db: DB, url: string, readAt: string, body: string): string {
  const prev = previousReading(db, url, readAt);
  if (!prev) return "";
  const lines = compareReadings(prev.body, prev.readAt, body, readAt);
  if (!lines.length) return "";
  return [
    `CHANGE SINCE DELPHILENS'S EARLIER READING OF THIS SAME URL (read at ${prev.readAt}, now ${readAt}):`,
    ...lines.map((l) => `- ${l}`),
  ].join("\n");
}
