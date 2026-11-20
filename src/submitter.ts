import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EvidenceApiError, TermsNotAcceptedError } from "@gensyn-ai/gensyn-delphi-sdk";
import type { DB } from "./db";
import { markSubmitted } from "./guardrails";
import { normalizeUrl } from "./hashing";
import type { EvidenceApi, Submission } from "./evidence/types";

export type IssueReporter = (kind: string, detail: string, context?: Record<string, unknown>) => void;

export interface SubmissionRow {
  id: number;
  market_id: string;
  stance: "YES" | "NO";
  note: string;
  links: string;
  files: string;
  confidence: number | null;
  status: string;
  remote_id: string | null;
  idempotency_key: string | null;
  verdict: string | null;
  reason: string | null;
  reward_base_units: string;
  bounty_state: string | null;
  zero_pay_reason: string | null;
  created_at: string;
  submitted_at: string | null;
  judged_at: string | null;
}

export class SubmitBlockedError extends Error {}

export function getSubmissionRow(db: DB, id: number): SubmissionRow {
  const row = db.prepare("SELECT * FROM submissions WHERE id = ?").get(id) as SubmissionRow | undefined;
  if (!row) throw new Error(`No submission with id ${id}`);
  return row;
}

function toFiles(paths: string[]): File[] {
  return paths
    .filter((p) => fs.existsSync(p))
    .map((p) => new File([fs.readFileSync(p)], path.basename(p), { type: "text/markdown" }));
}

/** Store what Delphi reports about a submission: status, verdict, rationale and reward. */
export function applySubmission(db: DB, id: number, sub: Submission): void {
  const market = sub.markets[0];
  const judged = ["judged", "rejected", "failed", "unmatched"].includes(sub.status);
  db.prepare(
    `UPDATE submissions SET status = ?, verdict = ?, reason = ?, reward_base_units = ?, bounty_state = ?,
       zero_pay_reason = ?, judged_at = CASE WHEN ? AND judged_at IS NULL THEN datetime('now') ELSE judged_at END
     WHERE id = ?`,
  ).run(
    sub.status,
    market?.verdict ?? null,
    market?.reason ?? sub.code ?? null,
    market?.bounty?.amount ?? "0",
    market?.bounty?.state ?? null,
    market?.zeroPayReason ?? null,
    judged ? 1 : 0,
    id,
  );
}

/**
 * Send one approved draft to Delphi.
 * Checks the server-side slot count and our own earlier submissions first, so a
 * submission is never wasted on a full market or on information already sent.
 */
export async function submitDraft(db: DB, api: EvidenceApi, id: number, report?: IssueReporter): Promise<SubmissionRow> {
  const row = getSubmissionRow(db, id);
  if (row.status !== "draft") throw new SubmitBlockedError(`Submission ${id} is ${row.status}, not a draft`);
  const links: string[] = JSON.parse(row.links);

  const entry = (await api.getEntryState(row.market_id)).data;
  if (!entry.canSubmit || entry.remainingOnMarket <= 0) {
    throw new SubmitBlockedError(`Delphi will not accept more on this market: ${entry.reason ?? "no slots left"}`);
  }

  const sent = (await api.listSubmissions({ market: row.market_id, limit: 50 })).data.items;
  const sentLinks = new Set(sent.flatMap((s) => s.links ?? []).map(normalizeUrl));
  const repeat = links.find((l) => sentLinks.has(normalizeUrl(l)));
  if (repeat) throw new SubmitBlockedError(`Already submitted from this account: ${repeat}`);

  // Persist the idempotency key first, so a crash and retry cannot double-submit.
  const key = row.idempotency_key ?? randomUUID();
  db.prepare("UPDATE submissions SET idempotency_key = ? WHERE id = ?").run(key, id);

  let sub: Submission;
  try {
    sub = (
      await api.submitEvidence({
        note: row.note,
        links,
        files: toFiles(JSON.parse(row.files)),
        marketAddress: row.market_id,
        idempotencyKey: key,
      })
    ).data;
  } catch (err) {
    if (err instanceof TermsNotAcceptedError) {
      throw new SubmitBlockedError(
        `Delphi's evidence terms (version ${err.terms.version}) are not accepted yet. Read ${err.terms.url}, then run: npm start -- terms --accept ${err.terms.version}`,
      );
    }
    if (err instanceof EvidenceApiError) {
      report?.("api_error", `${err.code}: ${err.message}`, {
        status: err.status,
        retryable: err.retryable,
        limit: err.limit,
        requestId: err.requestId,
        market: row.market_id,
      });
    }
    throw err;
  }
  markSubmitted(db, id, sub.id, sub.status);
  applySubmission(db, id, sub);
  return getSubmissionRow(db, id);
}

const PENDING = ["queued", "judging"];

/** Refresh every submission still waiting for a verdict, plus rewards not yet paid out. */
export async function pollSubmissions(db: DB, api: EvidenceApi, report?: IssueReporter): Promise<number> {
  const rows = db
    .prepare(
      `SELECT id, remote_id FROM submissions WHERE remote_id IS NOT NULL
         AND (status IN (${PENDING.map(() => "?").join(",")}) OR bounty_state = 'held')`,
    )
    .all(...PENDING) as { id: number; remote_id: string }[];
  let updated = 0;
  for (const row of rows) {
    try {
      applySubmission(db, row.id, (await api.getSubmission(row.remote_id)).data);
      updated++;
    } catch (err) {
      report?.("poll_error", (err as Error).message, { remoteId: row.remote_id });
    }
  }
  return updated;
}
