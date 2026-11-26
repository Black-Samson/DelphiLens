import type { DB } from "../db";

export const MAX_LESSONS = 6;

/**
 * Recent judge reasons for submissions that earned nothing, with a short piece
 * of what was sent. Fed to the verifier so it learns what this judge rejects.
 */
export function recentLessons(db: DB, limit = MAX_LESSONS): string[] {
  const rows = db
    .prepare(
      `SELECT s.verdict, s.status, s.reason, s.note, s.zero_pay_reason, m.question FROM submissions s
         LEFT JOIN markets m ON m.market_id = s.market_id
        WHERE s.status IN ('judged', 'rejected')
          AND (s.reward_base_units IS NULL OR s.reward_base_units = '0')
          AND ((s.reason IS NOT NULL AND s.reason != '') OR s.zero_pay_reason IS NOT NULL)
        ORDER BY s.judged_at DESC, s.id DESC LIMIT ?`,
    )
    .all(limit) as {
    verdict: string | null;
    status: string;
    reason: string | null;
    note: string;
    zero_pay_reason: string | null;
    question: string | null;
  }[];
  return rows.map((r) => {
    const sent = r.note.split("\n")[0].replace(/\s+/g, " ").slice(0, 160);
    const label =
      r.zero_pay_reason === "below_minimum"
        ? "ACCEPTED BUT PAID NOTHING (moved the forecast too little: a hint, not a decisive fact)"
        : (r.verdict ?? r.status).toUpperCase();
    return `${label}: "${r.reason ?? ""}" (we sent: ${sent}${r.note.length > 160 ? "..." : ""})`;
  });
}
