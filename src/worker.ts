import fs from "node:fs";
import path from "node:path";
import { minerDeps, type App } from "./app";
import { deliverDigest } from "./delivery";
import { prioritizeMarkets } from "./guardrails";
import { fetchMarkets } from "./markets/source";
import { getMarket, saveMarkets } from "./markets/store";
import { buildDigest, renderHtml, renderMarkdown, saveDigest } from "./newsletter";
import { mineMarket } from "./research/miner";
import { pollSubmissions, submitDraft, SubmitBlockedError } from "./submitter";

export interface CycleOptions {
  maxMarkets?: number;
  sendDigest?: boolean;
  now?: Date;
  log?: (line: string) => void;
}

export interface CycleSummary {
  marketsSeen: number;
  newMarkets: number;
  drafts: number;
  submitted: number;
  polled: number;
  digest: string | null;
}

/** Markets first seen within this window, and not yet mined, jump the queue. */
export const NEW_MARKET_HOURS = 24;

/** Ids of markets seen for the first time recently that have no submissions yet. */
export function newUnminedMarkets(app: App, now = new Date()): Set<string> {
  const since = new Date(now.getTime() - NEW_MARKET_HOURS * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  const rows = app.db
    .prepare(
      `SELECT m.market_id FROM markets m WHERE m.first_seen_at >= ? AND m.status = 'open'
         AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.market_id = m.market_id AND s.status != 'discarded')`,
    )
    .all(since) as { market_id: string }[];
  return new Set(rows.map((r) => r.market_id));
}

/** Markets that already have a draft waiting for review are skipped until it is handled. */
function hasOpenDraft(app: App, marketId: string): boolean {
  return Boolean(app.db.prepare("SELECT 1 FROM submissions WHERE market_id = ? AND status = 'draft'").get(marketId));
}

export async function submitPendingDrafts(app: App, log: (l: string) => void = () => {}): Promise<number> {
  const drafts = app.db.prepare("SELECT id, market_id FROM submissions WHERE status = 'draft' ORDER BY id").all() as {
    id: number;
    market_id: string;
  }[];
  let sent = 0;
  for (const d of drafts) {
    try {
      await submitDraft(app.db, app.evidence, d.id, app.report);
      sent++;
      log(`Submitted draft #${d.id}`);
    } catch (err) {
      log(`Draft #${d.id} not sent: ${(err as Error).message}`);
      if (err instanceof SubmitBlockedError) app.report("tool_limitation", (err as Error).message, { draft: d.id });
      if (/terms/i.test((err as Error).message)) break;
    }
  }
  return sent;
}

/** One pass: refresh markets, mine the best ones, submit if allowed, poll verdicts, write the daily digest. */
export async function runCycle(app: App, opts: CycleOptions = {}): Promise<CycleSummary> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  const summary: CycleSummary = { marketsSeen: 0, newMarkets: 0, drafts: 0, submitted: 0, polled: 0, digest: null };

  try {
    const markets = await fetchMarkets(app.settings, { now });
    summary.marketsSeen = markets.length;
    summary.newMarkets = saveMarkets(app.db, markets).length;
    if (markets.length) {
      const ids = markets.map((m) => m.marketId);
      app.db
        .prepare(`UPDATE markets SET status = 'closed' WHERE market_id NOT IN (${ids.map(() => "?").join(",")})`)
        .run(...ids);
    }
    log(`Markets: ${markets.length} open, ${summary.newMarkets} new`);

    // Getting there first matters: brand-new markets go to the front of the queue.
    const fresh = newUnminedMarkets(app, now);
    const ranked = prioritizeMarkets(app.db, markets, now)
      .filter((m) => !hasOpenDraft(app, m.marketId))
      .sort((a, b) => Number(fresh.has(b.marketId)) - Number(fresh.has(a.marketId)));
    if (fresh.size) log(`New markets first: ${fresh.size}`);
    for (const market of ranked.slice(0, opts.maxMarkets ?? 3)) {
      const outcome = await mineMarket(app.db, getMarket(app.db, market.marketId) ?? market, minerDeps(app));
      log(`Mined "${market.question}": ${outcome.status}${outcome.stance ? ` (${outcome.stance})` : ""}`);
      if (outcome.status === "draft_created") summary.drafts++;
    }
  } catch (err) {
    app.report("api_error", `Market refresh failed: ${(err as Error).message}`);
    log(`Market refresh failed: ${(err as Error).message}`);
  }

  if (app.settings.autoSubmit) summary.submitted = await submitPendingDrafts(app, log);
  summary.polled = await pollSubmissions(app.db, app.evidence, app.report);

  const today = path.join(app.settings.reportsDir, `digest_${now.toISOString().slice(0, 10)}.md`);
  if (!fs.existsSync(today)) {
    const digest = buildDigest(app.db, new Date(now.getTime() - 86_400_000), now);
    summary.digest = saveDigest(digest, app.settings.reportsDir).markdown;
    if (opts.sendDigest ?? true) {
      const result = await deliverDigest(app.settings, {
        subject: `DelphiLens digest ${now.toISOString().slice(0, 10)}`,
        markdown: renderMarkdown(digest),
        html: renderHtml(digest),
      });
      log(`Digest saved (discord: ${result.discord}, email: ${result.email})`);
    }
  }
  return summary;
}

/**
 * Run cycles forever, every WORKER_INTERVAL_MINUTES, until Ctrl+C.
 * The app is rebuilt each cycle so dashboard switches (mock mode, auto-submit) take effect.
 */
export async function runWorker(makeApp: () => App, log: (line: string) => void = console.log): Promise<void> {
  let stopping = false;
  const stop = () => {
    stopping = true;
    log("Stopping after this cycle...");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  log("DelphiLens worker started. Press Ctrl+C to stop.");
  while (!stopping) {
    const started = Date.now();
    let minutes = 30;
    let pollMinutes = 5;
    try {
      const app = makeApp();
      minutes = app.settings.workerIntervalMinutes;
      pollMinutes = app.settings.marketPollMinutes;
      log(`Cycle (${app.modes.delphi} Delphi, auto-submit ${app.settings.autoSubmit ? "on" : "off"})`);
      const s = await runCycle(app, { log: (l) => log(`  ${l}`) });
      log(`Cycle done: ${s.drafts} drafts, ${s.submitted} submitted, ${s.polled} receipts checked`);
      app.db.close();
    } catch (err) {
      log(`Cycle failed: ${(err as Error).message}`);
    }
    const wait = Math.max(0, minutes * 60_000 - (Date.now() - started));
    let nextPoll = Date.now() + pollMinutes * 60_000;
    for (let waited = 0; waited < wait && !stopping; waited += 1000) {
      await new Promise((r) => setTimeout(r, 1000));
      if (Date.now() < nextPoll) continue;
      nextPoll = Date.now() + pollMinutes * 60_000;
      if ((await checkForNewMarkets(makeApp, log)) > 0) break; // start a cycle now
    }
  }
}

/** Light check between cycles. Returns how many markets appeared since the last look. */
export async function checkForNewMarkets(makeApp: () => App, log: (line: string) => void = () => {}): Promise<number> {
  try {
    const app = makeApp();
    try {
      const fresh = saveMarkets(app.db, await fetchMarkets(app.settings)).length;
      if (fresh) log(`${fresh} new market(s) opened: mining now`);
      return fresh;
    } finally {
      app.db.close();
    }
  } catch (err) {
    log(`New-market check failed: ${(err as Error).message}`);
    return 0;
  }
}
