import type { DB } from "./db";
import { hashText, hashUrl } from "./hashing";

export const MAX_SUBMISSIONS_PER_MARKET = 3;
/** Local markdown snapshots kept per draft for your review (they are not uploaded). */
export const MAX_FILES_PER_SUBMISSION = 3;
/** Delphi counts the note, each link and each uploaded file as one item, 3 at most. */
export const MAX_ITEMS_PER_SUBMISSION = 3;
/** So a note can carry at most 2 sources. */
export const MAX_SOURCES_PER_SUBMISSION = MAX_ITEMS_PER_SUBMISSION - 1;
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

// ----------------------------------------------------------------- duplicates

/** Reasons a set of links or a claim was already used (by any market). */
export function findDuplicates(db: DB, links: readonly string[], note: string): string[] {
  const exists = db.prepare("SELECT 1 FROM claim_hashes WHERE hash = ?");
  const reasons: string[] = [];
  for (const link of links) {
    if (exists.get(hashUrl(link))) reasons.push(`Duplicate source URL: ${link}`);
  }
  if (note.trim() && exists.get(hashText(note))) reasons.push("Duplicate claim summary");
  return reasons;
}

// ----------------------------------------------------------------- full check

export interface DraftInput {
  marketId: string;
  stance: string;
  note: string;
  links: readonly string[];
  files?: readonly string[];
  confidence?: number;
}

export function checkSubmission(db: DB, input: DraftInput): string[] {
  const reasons: string[] = [];
  const stance = input.stance.toUpperCase();
  if (!isStance(stance)) reasons.push(`Stance must be YES or NO, got "${input.stance}"`);

  const locked = getLockedStance(db, input.marketId);
  if (locked && isStance(stance) && stance !== locked) {
    reasons.push(`Market is locked to ${locked}; ${stance} evidence is blocked`);
  }
  if (countSubmissions(db, input.marketId) >= MAX_SUBMISSIONS_PER_MARKET) {
    reasons.push(`Max ${MAX_SUBMISSIONS_PER_MARKET} submissions per market`);
  }
  if ((input.files?.length ?? 0) > MAX_FILES_PER_SUBMISSION) {
    reasons.push(`Max ${MAX_FILES_PER_SUBMISSION} snapshots per draft`);
  }
  const items = (input.note.trim() ? 1 : 0) + input.links.length;
  if (items > MAX_ITEMS_PER_SUBMISSION) {
    reasons.push(`Max ${MAX_ITEMS_PER_SUBMISSION} items per submission (the note counts as one), got ${items}`);
  }
  if (!input.note.trim()) reasons.push("Evidence note cannot be empty");
  if (input.links.length === 0) reasons.push("At least one dated source link is required");
  reasons.push(...findDuplicates(db, input.links, input.note));
  return reasons;
}

// ------------------------------------------------------------ draft lifecycle

function rememberHashes(db: DB, input: DraftInput, submissionId: number): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO claim_hashes (hash, kind, market_id, submission_id) VALUES (?, ?, ?, ?)",
  );
  for (const link of input.links) insert.run(hashUrl(link), "url", input.marketId, submissionId);
  insert.run(hashText(input.note), "claim", input.marketId, submissionId);
}

/** Validate and store a draft. Throws GuardrailError if any rule is broken. */
export function createDraft(db: DB, input: DraftInput): number {
  return db.transaction(() => {
    const reasons = checkSubmission(db, input);
    if (reasons.length) throw new GuardrailError(reasons);
    const info = db
      .prepare(
        "INSERT INTO submissions (market_id, stance, note, links, files, confidence, status) VALUES (?, ?, ?, ?, ?, ?, 'draft')",
      )
      .run(
        input.marketId,
        input.stance.toUpperCase(),
        input.note.trim(),
        JSON.stringify(input.links),
        JSON.stringify(input.files ?? []),
        input.confidence ?? null,
      );
    const id = Number(info.lastInsertRowid);
    rememberHashes(db, input, id);
    return id;
  })();
}

interface SubmissionRow {
  id: number;
  market_id: string;
  stance: Stance;
  status: string;
}

function getRow(db: DB, id: number): SubmissionRow {
  const row = db.prepare("SELECT id, market_id, stance, status FROM submissions WHERE id = ?").get(id) as
    | SubmissionRow
    | undefined;
  if (!row) throw new Error(`No submission with id ${id}`);
  return row;
}

/** Record that a draft was sent to Delphi. This permanently locks the market's stance. */
export function markSubmitted(db: DB, id: number, remoteId: string, status = "queued"): void {
  const row = getRow(db, id);
  db.transaction(() => {
    db.prepare(
      "UPDATE submissions SET status = ?, remote_id = ?, submitted_at = datetime('now') WHERE id = ?",
    ).run(status, remoteId, id);
    lockStance(db, row.market_id, row.stance);
  })();
}

/** Reject a draft before it is sent: frees its slot and its link/claim hashes. */
export function discardDraft(db: DB, id: number): void {
  const row = getRow(db, id);
  if (row.status !== "draft") throw new Error("Only drafts that were not sent can be discarded");
  db.transaction(() => {
    db.prepare("UPDATE submissions SET status = 'discarded' WHERE id = ?").run(id);
    db.prepare("DELETE FROM claim_hashes WHERE submission_id = ?").run(id);
  })();
}

// -------------------------------------------------------------- qualification

export interface Qualification {
  judged: number;
  markets: number;
  qualified: boolean;
}

/** Prizes need at least 10 judged submissions across at least 3 markets. */
export function qualificationProgress(db: DB): Qualification {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS judged, COUNT(DISTINCT market_id) AS markets FROM submissions WHERE status = 'judged'",
    )
    .get() as { judged: number; markets: number };
  return { ...row, qualified: row.judged >= QUALIFY_JUDGED && row.markets >= QUALIFY_MARKETS };
}

export interface RankableMarket {
  marketId: string;
  rewardPot: number;
  yesOdds: number | null;
  evidenceCutoff: string | null;
}

/** Markets priced between 20% and 80% have the most room for evidence to move the forecaster. */
export function isContested(yesOdds: number | null): boolean {
  return yesOdds === null || (yesOdds >= 0.2 && yesOdds <= 0.8);
}

/**
 * Order markets for mining and drop the ones we cannot use.
 *
 * Until we qualify, untouched markets come first so submissions spread across
 * 3+ markets early. After that, contested markets with the biggest pots win.
 */
export function prioritizeMarkets<T extends RankableMarket>(db: DB, markets: T[], now = new Date()): T[] {
  const { qualified } = qualificationProgress(db);
  const scored: { key: number[]; market: T }[] = [];
  for (const market of markets) {
    const used = countSubmissions(db, market.marketId);
    if (used >= MAX_SUBMISSIONS_PER_MARKET) continue;
    if (market.evidenceCutoff && new Date(market.evidenceCutoff) <= now) continue;
    const contested = isContested(market.yesOdds) ? 0 : 1;
    const key = qualified
      ? [contested, -market.rewardPot, used]
      : [used > 0 ? 1 : 0, contested, used, -market.rewardPot];
    scored.push({ key, market });
  }
  scored.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    return 0;
  });
  return scored.map((item) => item.market);
}

export const MAX_NOTE_CHARS = 8000;

/** Replace a draft's note (before it is sent). Keeps the claim hash in step for the duplicate blocker. */
export function updateDraftNote(db: DB, id: number, note: string): void {
  const row = getRow(db, id);
  if (row.status !== "draft") throw new Error("Only drafts that were not sent can be edited");
  const text = note.trim();
  if (!text) throw new GuardrailError(["Evidence note cannot be empty"]);
  if (text.length > MAX_NOTE_CHARS) throw new GuardrailError([`Delphi caps notes at ${MAX_NOTE_CHARS} characters`]);
  const clash = db
    .prepare("SELECT submission_id FROM claim_hashes WHERE hash = ? AND kind = 'claim' AND submission_id != ?")
    .get(hashText(text), id) as { submission_id: number } | undefined;
  if (clash) throw new GuardrailError([`Duplicate claim: same note as submission #${clash.submission_id}`]);
  db.transaction(() => {
    db.prepare("UPDATE submissions SET note = ? WHERE id = ?").run(text, id);
    db.prepare("DELETE FROM claim_hashes WHERE submission_id = ? AND kind = 'claim'").run(id);
    db.prepare("INSERT OR IGNORE INTO claim_hashes (hash, kind, market_id, submission_id) VALUES (?, 'claim', ?, ?)").run(
      hashText(text),
      row.market_id,
      id,
    );
  })();
}
