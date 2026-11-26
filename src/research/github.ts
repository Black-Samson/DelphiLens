import type { MarketInfo } from "../markets/types";

/**
 * GitHub helpers. Release markets ("Will owner/repo publish release X...") are
 * best answered from GitHub's releases API: exact tags and publish times.
 */

const REPO = /github\.com\/([\w.-]+)\/([\w.-]+)/i;
const QUESTION_REPO = /\b([\w.-]+)\/([\w.-]+)\s+(?:publish|release|tag|ship)/i;

/** owner/repo a market is about, from its data sources or its question. */
export function marketRepo(market: Pick<MarketInfo, "question" | "dataSources">): string | null {
  for (const source of market.dataSources ?? []) {
    const m = source.match(REPO);
    if (m && m[1] !== "api") return `${m[1]}/${m[2].replace(/\.git$/, "")}`;
  }
  const q = market.question.match(QUESTION_REPO);
  return q ? `${q[1]}/${q[2]}` : null;
}

export function releasesApiUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/releases?per_page=15`;
}

/** Programs-first APIs: robots.txt there addresses crawlers, not single API reads. */
export const PUBLIC_API_HOSTS = ["api.github.com"];

interface Release {
  tag_name?: string;
  name?: string;
  published_at?: string;
  prerelease?: boolean;
  draft?: boolean;
  html_url?: string;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** A compact, readable list of releases: the full API answer is mostly release notes. */
export function summarizeReleases(json: unknown): string | null {
  if (!Array.isArray(json)) return null;
  const releases = (json as Release[]).filter((r) => r && r.tag_name && !r.draft);
  if (!releases.length) return null;
  const lines = releases.map(
    (r) => `${r.tag_name}${r.prerelease ? " (pre-release)" : ""} published ${r.published_at ?? "unknown"}${r.html_url ? ` ${r.html_url}` : ""}`,
  );
  const dates = releases.map((r) => Date.parse(r.published_at ?? "")).filter(Number.isFinite).sort((a, b) => b - a);
  let rhythm = "";
  if (dates.length >= 3) {
    const gaps = dates.slice(0, -1).map((d, i) => (d - dates[i + 1]) / 86_400_000);
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const spanDays = (dates[0] - dates[dates.length - 1]) / 86_400_000;
    rhythm =
      `Release rhythm: ${dates.length} releases between ${new Date(dates[dates.length - 1]).toISOString().slice(0, 10)} and ` +
      `${new Date(dates[0]).toISOString().slice(0, 10)} (${spanDays.toFixed(0)} days). ` +
      `Average gap ${avg.toFixed(1)} days, median ${median(gaps).toFixed(1)}, shortest ${Math.min(...gaps).toFixed(1)}, ` +
      `longest ${Math.max(...gaps).toFixed(1)}. ${gaps.filter((g) => g <= 14).length} of ${gaps.length} gaps were 14 days or less.\n`;
  }
  return `${rhythm}GitHub releases, newest first:\n${lines.join("\n")}`;
}
