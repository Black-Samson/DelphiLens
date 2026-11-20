import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DB } from "./db";

export type FeedbackKind =
  | "api_error"
  | "rate_limit"
  | "ambiguous_market"
  | "tool_limitation"
  | "search_error"
  | "llm_error"
  | "poll_error"
  | "note";

export interface FeedbackEntry {
  id: number;
  kind: FeedbackKind;
  source: string;
  detail: string;
  context: Record<string, unknown>;
  count: number;
  created_at: string;
  last_seen: string;
}

const TITLES: Record<FeedbackKind, string> = {
  api_error: "API errors",
  rate_limit: "Rate limits",
  ambiguous_market: "Ambiguous market criteria",
  tool_limitation: "Things the agent could not do",
  search_error: "Search provider problems",
  llm_error: "LLM problems",
  poll_error: "Receipt polling problems",
  note: "Other notes",
};

/** Same kind and same message (ignoring numbers and ids) count as one issue seen several times. */
function fingerprint(kind: string, detail: string): string {
  const shape = detail.toLowerCase().replace(/0x[0-9a-f]+|[0-9a-f-]{16,}|\d+/g, "#");
  return createHash("sha256").update(`${kind}|${shape}`).digest("hex");
}

export function classify(kind: string, detail: string): FeedbackKind {
  if (/rate_limited|429|too many/i.test(detail)) return "rate_limit";
  return (kind in TITLES ? kind : "note") as FeedbackKind;
}

/** Record an issue for the feedback bounty report. Repeats bump a counter instead of piling up. */
export function logFeedback(
  db: DB,
  kind: string,
  detail: string,
  context: Record<string, unknown> = {},
  source = "agent",
): void {
  const k = classify(kind, detail);
  db.prepare(
    `INSERT INTO feedback (kind, source, detail, context, fingerprint) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(fingerprint) DO UPDATE SET count = count + 1, last_seen = datetime('now'), context = excluded.context`,
  ).run(k, source, detail.slice(0, 2000), JSON.stringify(context), fingerprint(k, detail));
}

export function listFeedback(db: DB): FeedbackEntry[] {
  return (db.prepare("SELECT * FROM feedback ORDER BY count DESC, last_seen DESC").all() as (Omit<FeedbackEntry, "context"> & {
    context: string;
  })[]).map((row) => ({ ...row, context: JSON.parse(row.context) }));
}

export function renderFeedbackReport(entries: FeedbackEntry[], now = new Date()): string {
  const lines = [
    "# DelphiLens feedback notes",
    "",
    `Generated ${now.toISOString().slice(0, 16).replace("T", " ")} UTC by the DelphiLens agent.`,
    "Issues the agent hit while mining evidence, grouped by type and ordered by how often they happened.",
    "",
  ];
  if (!entries.length) return [...lines, "No issues recorded yet.", ""].join("\n");
  for (const kind of Object.keys(TITLES) as FeedbackKind[]) {
    const group = entries.filter((e) => e.kind === kind);
    if (!group.length) continue;
    lines.push(`## ${TITLES[kind]}`, "");
    for (const e of group) {
      const seen = e.count > 1 ? ` (seen ${e.count} times, last ${e.last_seen} UTC)` : ` (${e.created_at} UTC)`;
      lines.push(`- ${e.detail}${seen}`);
      const ctx = Object.entries(e.context).filter(([, v]) => v !== null && v !== undefined && v !== "");
      if (ctx.length) lines.push(`  - Context: ${ctx.map(([k, v]) => `${k}=${String(v)}`).join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function exportFeedbackReport(db: DB, reportsDir: string, now = new Date()): string {
  fs.mkdirSync(reportsDir, { recursive: true });
  const file = path.join(reportsDir, "feedback_bounty_notes.md");
  fs.writeFileSync(file, renderFeedbackReport(listFeedback(db), now), "utf8");
  return file;
}
