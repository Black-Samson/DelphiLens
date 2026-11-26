import type { DB } from "../db";

export const MAX_LESSONS = 6;

/**
 * Recent judge reasons for submissions that earned nothing, with a short piece
 * of what was sent. Fed to the verifier so it learns what this judge rejects.
 */
export function recentLessons(db: DB, limit = MAX_LESSONS): string[] {
  const rows = db
    .prepare(
      `SELECT s.verdict, s.status, s.reason, s.note, m.question FROM submissions s
         LEFT JOIN markets m ON m.market_id = s.market_id
        WHERE s.reason IS NOT NULL AND s.reason != ''
          AND (s.verdict IS NULL OR s.verdict != 'accepted')
          AND s.status IN ('judged', 'rejected')
        ORDER BY s.judged_at DESC, s.id DESC LIMIT ?`,
    )
    .all(limit) as { verdict: string | null; status: string; reason: string; note: string; question: string | null }[];
  return rows.map((r) => {
    const sent = r.note.split("\n")[0].replace(/\s+/g, " ").slice(0, 160);
    return `${(r.verdict ?? r.status).toUpperCase()}: "${r.reason}" (we sent: ${sent}${r.note.length > 160 ? "..." : ""})`;
  });
}
