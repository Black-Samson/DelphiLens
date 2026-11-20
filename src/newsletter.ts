import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db";
import { baseUnitsToUsdc } from "./evidence/types";
import { marketsOpenedSince } from "./markets/store";
import type { MarketInfo } from "./markets/types";
import { computeStats, type Stats } from "./stats";

export interface DigestVerdict {
  question: string;
  stance: string;
  verdict: string;
  reason: string;
  usdc: number;
  judgedAt: string;
}

export interface Digest {
  generatedAt: string;
  since: string;
  newMarkets: MarketInfo[];
  verdicts: DigestVerdict[];
  periodUsdc: number;
  stats: Stats;
}

/** SQLite datetime text (UTC) for a Date. */
export function sqlTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function buildDigest(db: DB, since: Date, now = new Date()): Digest {
  const verdicts = (
    db
      .prepare(
        `SELECT m.question, s.stance, s.verdict, s.status, s.reason, s.reward_base_units, s.judged_at
           FROM submissions s LEFT JOIN markets m ON m.market_id = s.market_id
          WHERE s.judged_at >= ? ORDER BY s.judged_at DESC`,
      )
      .all(sqlTime(since)) as {
      question: string | null;
      stance: string;
      verdict: string | null;
      status: string;
      reason: string | null;
      reward_base_units: string;
      judged_at: string;
    }[]
  ).map((r) => ({
    question: r.question ?? "(unknown market)",
    stance: r.stance,
    verdict: r.verdict ?? r.status,
    reason: r.reason ?? "",
    usdc: baseUnitsToUsdc(r.reward_base_units),
    judgedAt: r.judged_at,
  }));
  return {
    generatedAt: now.toISOString(),
    since: since.toISOString(),
    newMarkets: marketsOpenedSince(db, sqlTime(since)),
    verdicts,
    periodUsdc: verdicts.reduce((s, v) => s + v.usdc, 0),
    stats: computeStats(db),
  };
}

const usd = (n: number) => `${n.toFixed(2)} USDC.e`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

export function renderMarkdown(d: Digest): string {
  const { stats: s } = d;
  const accepted = d.verdicts.filter((v) => v.verdict === "accepted").length;
  const lines = [
    `# DelphiLens digest, ${d.generatedAt.slice(0, 10)}`,
    "",
    `Covers ${d.since.slice(0, 16).replace("T", " ")} to ${d.generatedAt.slice(0, 16).replace("T", " ")} UTC.`,
    "",
    "## Summary",
    "",
    `- Earned this period: **${usd(d.periodUsdc)}** (total ${usd(s.totalUsdc)})`,
    `- Verdicts this period: ${d.verdicts.length} (${accepted} accepted, ${d.verdicts.length - accepted} not)`,
    `- Acceptance rate overall: ${pct(s.acceptanceRate)} of ${s.judged} judged`,
    `- Waiting: ${s.drafts} drafts to review, ${s.pending} with the judge`,
    `- Qualification: ${s.qualification.judged}/10 judged submissions, ${s.qualification.markets}/3 markets${
      s.qualification.qualified ? " (qualified)" : ""
    }`,
    "",
    "## New markets",
    "",
  ];
  if (!d.newMarkets.length) lines.push("No new markets.", "");
  for (const m of d.newMarkets) {
    const odds = m.yesOdds === null ? "no price" : `YES ${pct(m.yesOdds)}`;
    lines.push(`- ${m.question} (${m.category}, ${odds}, pot ${usd(m.rewardPot)}, cutoff ${m.evidenceCutoff?.slice(0, 10) ?? "n/a"})`);
  }
  if (d.newMarkets.length) lines.push("");
  lines.push("## Judge verdicts", "");
  if (!d.verdicts.length) lines.push("No verdicts this period.", "");
  for (const v of d.verdicts) {
    lines.push(`- **${v.verdict.toUpperCase()}** (${v.stance}, ${usd(v.usdc)}): ${v.question}`);
    if (v.reason) lines.push(`  - Rationale: ${v.reason}`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Email-safe HTML in the Sack of Chaos palette. */
export function renderHtml(d: Digest): string {
  const { stats: s } = d;
  const kpi = (label: string, value: string) =>
    `<td style="padding:14px;border:1px solid #1E2D2A;background:#101C1A"><div style="font-size:11px;letter-spacing:2px;color:#D4A85A;text-transform:uppercase">${label}</div><div style="font-size:24px;color:#EFE4CC;font-weight:700;margin-top:6px">${value}</div></td>`;
  const markets = d.newMarkets
    .map((m) => `<li>${esc(m.question)} <span style="color:#A9BDB8">(${esc(m.category)}, pot ${usd(m.rewardPot)})</span></li>`)
    .join("");
  const verdicts = d.verdicts
    .map(
      (v) =>
        `<li><b style="color:${v.verdict === "accepted" ? "#D4A85A" : "#D9532B"}">${esc(v.verdict.toUpperCase())}</b> ${esc(
          v.question,
        )} <span style="color:#A9BDB8">(${esc(v.stance)}, ${usd(v.usdc)})</span>${
          v.reason ? `<br><span style="color:#A9BDB8">${esc(v.reason)}</span>` : ""
        }</li>`,
    )
    .join("");
  return `<!doctype html><html><body style="margin:0;background:#0A1211;color:#EFE4CC;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:680px;margin:0 auto;padding:28px 20px">
<div style="font-size:11px;letter-spacing:3px;color:#D4A85A">DELPHILENS DIGEST</div>
<h1 style="font-size:32px;margin:8px 0 18px;color:#C9AE86">${d.generatedAt.slice(0, 10)}</h1>
<table style="border-collapse:collapse;width:100%"><tr>${kpi("Earned this period", usd(d.periodUsdc))}${kpi("Total", usd(s.totalUsdc))}</tr>
<tr>${kpi("Acceptance", pct(s.acceptanceRate))}${kpi("Qualification", `${s.qualification.judged}/10 &middot; ${s.qualification.markets}/3`)}</tr></table>
<h2 style="color:#C9AE86;font-size:18px;margin-top:26px">New markets</h2><ul style="line-height:1.6">${markets || "<li>No new markets.</li>"}</ul>
<h2 style="color:#C9AE86;font-size:18px">Judge verdicts</h2><ul style="line-height:1.6">${verdicts || "<li>No verdicts this period.</li>"}</ul>
</div></body></html>`;
}

/** Writes reports/digest_YYYY-MM-DD.md and .html. */
export function saveDigest(d: Digest, reportsDir: string): { markdown: string; html: string } {
  fs.mkdirSync(reportsDir, { recursive: true });
  const base = path.join(reportsDir, `digest_${d.generatedAt.slice(0, 10)}`);
  fs.writeFileSync(`${base}.md`, renderMarkdown(d), "utf8");
  fs.writeFileSync(`${base}.html`, renderHtml(d), "utf8");
  return { markdown: `${base}.md`, html: `${base}.html` };
}

export function latestDigest(reportsDir: string): { file: string; markdown: string } | null {
  if (!fs.existsSync(reportsDir)) return null;
  const files = fs.readdirSync(reportsDir).filter((f) => /^digest_\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  const last = files.at(-1);
  return last ? { file: last, markdown: fs.readFileSync(path.join(reportsDir, last), "utf8") } : null;
}
