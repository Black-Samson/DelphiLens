import type { DB } from "./db";

export const MAX_SUBMISSIONS_PER_MARKET = 3;
export const MAX_FILES_PER_SUBMISSION = 3;
export const QUALIFY_JUDGED = 10;
export const QUALIFY_MARKETS = 3;

export type Stance = "YES" | "NO";
export const STANCES: readonly Stance[] = ["YES", "NO"];

export function isStance(value: unknown): value is Stance {
  return value === "YES" || value === "NO";
}

/** Thrown when a submission would break a competition rule. */
export class GuardrailError extends Error {
  constructor(public readonly reasons: string[]) {
    super(reasons.join("; "));
    this.name = "GuardrailError";
  }
}

// ---------------------------------------------------------------- stance lock

/**
 * The stance this market is locked to, or null while it is still open.
 * A pending draft counts too, so two opposite drafts can never be queued:
 * evidence for both sides of one market cancels out in the ranking.
 */
export function getLockedStance(db: DB, marketId: string): Stance | null {
  const lock = db.prepare("SELECT stance FROM stance_locks WHERE market_id = ?").get(marketId) as
    | { stance: Stance }
    | undefined;
  if (lock) return lock.stance;
  const first = db
    .prepare(
      "SELECT stance FROM submissions WHERE market_id = ? AND status != 'discarded' ORDER BY id LIMIT 1",
    )
    .get(marketId) as { stance: Stance } | undefined;
  return first?.stance ?? null;
}

export function lockStance(db: DB, marketId: string, stance: Stance): void {
  db.prepare("INSERT OR IGNORE INTO stance_locks (market_id, stance) VALUES (?, ?)").run(marketId, stance);
}

// ----------------------------------------------------------------------- caps

/** Submissions that use one of the market's slots (everything except discarded drafts). */
export function countSubmissions(db: DB, marketId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM submissions WHERE market_id = ? AND status != 'discarded'")
    .get(marketId) as { c: number };
  return row.c;
}
