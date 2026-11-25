import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, minerDeps, type App } from "./app";
import { ROOT } from "./config";
import { setRuntimeFlag } from "./db";
import { deliverDigest } from "./delivery";
import { exportFeedbackReport, listFeedback, logFeedback, sendFeedback } from "./feedback";
import { countSubmissions, discardDraft, getLockedStance } from "./guardrails";
import { fetchMarkets } from "./markets/source";
import { getMarket, listMarkets, syncMarkets } from "./markets/store";
import { buildDigest, latestDigest, renderHtml, renderMarkdown, saveDigest } from "./newsletter";
import { mineMarket } from "./research/miner";
import { computeStats, earningsSeries } from "./stats";
import { pollSubmissions, submitDraft } from "./submitter";
import { baseUnitsToUsdc } from "./evidence/types";

const WEB = path.join(ROOT, "web");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function submissions(app: App, where = "1 = 1") {
  return (
    app.db
      .prepare(
        `SELECT s.*, m.question FROM submissions s LEFT JOIN markets m ON m.market_id = s.market_id
          WHERE ${where} ORDER BY s.id DESC LIMIT 200`,
      )
      .all() as Record<string, unknown>[]
  ).map((r) => ({
    ...r,
    links: JSON.parse(String(r.links)),
    files: (JSON.parse(String(r.files)) as string[]).map((f) => path.basename(f)),
    usdc: baseUnitsToUsdc(String(r.reward_base_units)),
  }));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

/** All dashboard API routes. The app is rebuilt after a settings change. */
export function createHandler(makeApp: () => App) {
  let app = makeApp();
  const routes: [string, RegExp, (m: RegExpMatchArray, req: http.IncomingMessage) => Promise<unknown>][] = [
    ["GET", /^\/api\/state$/, async () => ({
      modes: app.modes,
      autoSubmit: app.settings.autoSubmit,
      mockMode: app.settings.mockMode,
      stats: computeStats(app.db),
      earnings: earningsSeries(app.db),
      recent: submissions(app, "s.judged_at IS NOT NULL").slice(0, 8),
    })],
    ["POST", /^\/api\/settings$/, async (_m, req) => {
      const body = await readJson(req);
      const previous = { mockMode: app.settings.mockMode, autoSubmit: app.settings.autoSubmit };
      for (const key of ["mockMode", "autoSubmit"] as const) {
        if (typeof body[key] === "boolean") setRuntimeFlag(app.db, key, body[key] as boolean);
      }
      let next: App;
      try {
        next = makeApp();
      } catch (err) {
        // Refuse the switch (e.g. live mode without keys) instead of leaving a dashboard that cannot start.
        for (const key of ["mockMode", "autoSubmit"] as const) setRuntimeFlag(app.db, key, previous[key]);
        throw new HttpError(400, (err as Error).message.split("\n")[0]);
      }
      const old = app;
      app = next;
      old.db.close();
      // Switching between practice and live: show only the markets of the new mode.
      if (previous.mockMode !== app.settings.mockMode) {
        try {
          syncMarkets(app.db, await fetchMarkets(app.settings));
        } catch (err) {
          app.report("api_error", `Market refresh after switching mode failed: ${(err as Error).message}`);
        }
      }
      return { mockMode: app.settings.mockMode, autoSubmit: app.settings.autoSubmit, modes: app.modes };
    }],
    ["GET", /^\/api\/markets$/, async () =>
      listMarkets(app.db).map((m) => ({
        ...m,
        stance: getLockedStance(app.db, m.marketId) ?? "OPEN",
        used: countSubmissions(app.db, m.marketId),
      }))],
    ["POST", /^\/api\/markets\/refresh$/, async () => ({ new: syncMarkets(app.db, await fetchMarkets(app.settings)).length })],
    ["POST", /^\/api\/markets\/([^/]+)\/mine$/, async (m) => {
      const market = getMarket(app.db, decodeURIComponent(m[1]));
      if (!market) throw new HttpError(404, "Unknown market");
      return mineMarket(app.db, market, minerDeps(app));
    }],
    ["GET", /^\/api\/submissions$/, async () => submissions(app)],
    ["POST", /^\/api\/submissions\/(\d+)\/approve$/, async (m) => submitDraft(app.db, app.evidence, Number(m[1]), app.report)],
    ["POST", /^\/api\/submissions\/(\d+)\/discard$/, async (m) => {
      discardDraft(app.db, Number(m[1]));
      return { ok: true };
    }],
    ["POST", /^\/api\/poll$/, async () => ({ checked: await pollSubmissions(app.db, app.evidence, app.report) })],
    ["GET", /^\/api\/digest$/, async () => latestDigest(app.settings.reportsDir)],
    ["POST", /^\/api\/digest$/, async () => {
      const now = new Date();
      saveDigest(buildDigest(app.db, new Date(now.getTime() - 86_400_000), now), app.settings.reportsDir);
      return latestDigest(app.settings.reportsDir);
    }],
    ["POST", /^\/api\/digest\/send$/, async () => {
      const now = new Date();
      const digest = buildDigest(app.db, new Date(now.getTime() - 86_400_000), now);
      return deliverDigest(app.settings, {
        subject: `DelphiLens digest ${now.toISOString().slice(0, 10)}`,
        markdown: renderMarkdown(digest),
        html: renderHtml(digest),
      });
    }],
    ["GET", /^\/api\/feedback$/, async () => listFeedback(app.db)],
    ["POST", /^\/api\/feedback$/, async (_m, req) => {
      const body = await readJson(req);
      const detail = String(body.detail ?? "").trim();
      if (!detail) throw new HttpError(400, "detail is required");
      logFeedback(app.db, String(body.kind ?? "note"), detail, {}, "operator");
      return { ok: true };
    }],
    ["POST", /^\/api\/feedback\/(\d+)\/send$/, async (m) => ({ id: await sendFeedback(app.db, app.settings, Number(m[1])) })],
    ["POST", /^\/api\/feedback\/export$/, async () => ({
      file: path.basename(exportFeedbackReport(app.db, app.settings.reportsDir)),
      markdown: fs.readFileSync(path.join(app.settings.reportsDir, "feedback_bounty_notes.md"), "utf8"),
    })],
  ];

  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        for (const [method, pattern, handler] of routes) {
          const match = url.pathname.match(pattern);
          if (match && req.method === method) {
            const data = await handler(match, req);
            res.writeHead(200, { "Content-Type": "application/json" });
            return void res.end(JSON.stringify(data ?? null));
          }
        }
        throw new HttpError(404, "Not found");
      }
      if (url.pathname.startsWith("/snapshots/")) {
        const name = path.basename(decodeURIComponent(url.pathname));
        const file = path.join(app.settings.snapshotsDir, name);
        if (!name.endsWith(".md") || !fs.existsSync(file)) throw new HttpError(404, "Not found");
        res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` });
        return void res.end(fs.readFileSync(file));
      }
      const name = url.pathname === "/" ? "index.html" : path.basename(url.pathname);
      const file = path.join(WEB, name);
      if (!TYPES[path.extname(name)] || !fs.existsSync(file)) throw new HttpError(404, "Not found");
      res.writeHead(200, { "Content-Type": TYPES[path.extname(name)] });
      res.end(fs.readFileSync(file));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  };
}

export function startServer(port: number, makeApp: () => App = () => createApp()): http.Server {
  // Bound to localhost only: the dashboard can submit evidence, so it is never exposed to the network.
  return http.createServer(createHandler(makeApp)).listen(port, "127.0.0.1");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const probe = createApp();
    const port = probe.settings.dashboardPort;
    probe.db.close();
    startServer(port);
    console.log(`DelphiLens dashboard: http://localhost:${port}`);
  } catch (err) {
    console.error(`\n${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}
