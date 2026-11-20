import type { DB } from "./db";
import { baseUnitsToUsdc } from "./evidence/types";
import { qualificationProgress, type Qualification } from "./guardrails";

export interface Stats {
  totalUsdc: number;
  judged: number;
  accepted: number;
  rejected: number;
  acceptanceRate: number;
  pending: number;
  drafts: number;
  activeMarkets: number;
  qualification: Qualification;
}

export interface EarningPoint {
  date: string;
  usdc: number;
  cumulative: number;
}

export function computeStats(db: DB): Stats {
  const rows = db
    .prepare("SELECT status, verdict, reward_base_units FROM submissions WHERE status != 'discarded'")
    .all() as { status: string; verdict: string | null; reward_base_units: string }[];
  const judged = rows.filter((r) => r.status === "judged");
  const accepted = judged.filter((r) => r.verdict === "accepted").length;
  const rejected = rows.filter((r) => r.verdict === "rejected" || r.status === "rejected").length;
  const activeMarkets = (db.prepare("SELECT COUNT(*) AS c FROM markets WHERE status = 'open'").get() as { c: number }).c;
  return {
    totalUsdc: rows.reduce((sum, r) => sum + baseUnitsToUsdc(r.reward_base_units), 0),
    judged: judged.length,
    accepted,
    rejected,
    acceptanceRate: judged.length ? accepted / judged.length : 0,
    pending: rows.filter((r) => ["queued", "judging"].includes(r.status)).length,
    drafts: rows.filter((r) => r.status === "draft").length,
    activeMarkets,
    qualification: qualificationProgress(db),
  };
}

/** Rewards per judging day, with a running total, for the earnings chart. */
export function earningsSeries(db: DB): EarningPoint[] {
  const rows = db
    .prepare(
      "SELECT date(judged_at) AS day, reward_base_units FROM submissions WHERE judged_at IS NOT NULL ORDER BY judged_at",
    )
    .all() as { day: string; reward_base_units: string }[];
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + baseUnitsToUsdc(r.reward_base_units));
  let cumulative = 0;
  return [...byDay].map(([date, usdc]) => {
    cumulative += usdc;
    return { date, usdc, cumulative };
  });
}
