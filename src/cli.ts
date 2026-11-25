import { createApp, minerDeps } from "./app";
import { deliverDigest } from "./delivery";
import { formatChecks, runDoctor } from "./doctor";
import { exportFeedbackReport } from "./feedback";
import { discardDraft } from "./guardrails";
import { loadSettings } from "./config";
import { openDb, setRuntimeFlag } from "./db";
import { fetchMarkets } from "./markets/source";
import { getMarket, listMarkets, saveMarkets } from "./markets/store";
import { buildDigest, renderHtml, renderMarkdown, saveDigest } from "./newsletter";
import { mineMarket } from "./research/miner";
import { computeStats } from "./stats";
import { pollSubmissions, submitDraft } from "./submitter";
import { runCycle, runWorker } from "./worker";

const HELP = `DelphiLens commands (run with: npm start -- <command>)

  doctor                 Check the API key, terms, markets and limits (run this first)
  status                 Mode, qualification progress and earnings
  markets                Refresh and list open competition markets
  mine [marketId]        Mine evidence (best market, or the one given)
  drafts                 List drafts waiting for approval
  approve <id>           Submit a draft to Delphi
  discard <id>           Throw a draft away
  poll                   Check verdicts and rewards for sent submissions
  cycle                  Run one full worker cycle
  worker                 Run the worker loop (Ctrl+C to stop)
  digest [--send]        Write today's digest (and send it if --send)
  feedback               Export reports/feedback_bounty_notes.md
  terms [--accept <v>]   Show Delphi's evidence terms, or accept a version you have read
  mock on|off            Switch mock mode (overrides MOCK_MODE in .env)
`;

async function main(argv: string[]): Promise<void> {
  const [command = "help", ...args] = argv;
  if (command === "help" || command === "--help") return void console.log(HELP);
  if (command === "worker") return runWorker(() => createApp());
  if (command === "mock") {
    // Works even when live mode cannot start, so you can always get back to mock mode.
    if (args[0] !== "on" && args[0] !== "off") throw new Error("Use: npm start -- mock on   (or: mock off)");
    const db = openDb(loadSettings().dbPath);
    setRuntimeFlag(db, "mockMode", args[0] === "on");
    if (args[0] === "off") {
      try {
        createApp().db.close();
      } catch (err) {
        setRuntimeFlag(db, "mockMode", true);
        db.close();
        throw new Error(`${(err as Error).message.split("\n")[0]}\nMock mode stays on.`, { cause: err });
      }
    }
    db.close();
    console.log(`Mock mode ${args[0]}.`);
    return;
  }

  const app = createApp();
  try {
    switch (command) {
      case "doctor": {
        const checks = await runDoctor(app);
        console.log(formatChecks(checks));
        console.log(checks.every((c) => c.ok) ? "\nAll set." : "\nFix the lines marked FIX, then run doctor again.");
        break;
      }
      case "status": {
        const s = computeStats(app.db);
        console.log(`Delphi: ${app.modes.delphi} | search: ${app.modes.search} | LLM: ${app.modes.llm} | auto-submit: ${app.settings.autoSubmit ? "on" : "off"}`);
        console.log(`Qualification: ${s.qualification.judged}/10 judged, ${s.qualification.markets}/3 markets${s.qualification.qualified ? " (qualified)" : ""}`);
        console.log(`Earned: ${s.totalUsdc.toFixed(2)} USDC.e | accepted ${s.accepted}/${s.judged} | drafts ${s.drafts} | pending ${s.pending}`);
        break;
      }
      case "markets": {
        saveMarkets(app.db, await fetchMarkets(app.settings));
        for (const m of listMarkets(app.db)) {
          const odds = m.yesOdds === null ? "  ?" : `${Math.round(m.yesOdds * 100)}%`.padStart(4);
          console.log(`${odds}  ${m.rewardPot.toFixed(0).padStart(5)} USDC  ${m.marketId}  ${m.question}`);
        }
        break;
      }
      case "mine": {
        saveMarkets(app.db, await fetchMarkets(app.settings));
        const market = args[0] ? getMarket(app.db, args[0]) : listMarkets(app.db)[0];
        if (!market) throw new Error(`Unknown market ${args[0]}`);
        const out = await mineMarket(app.db, market, minerDeps(app));
        console.log(`${out.status}${out.stance ? ` (${out.stance})` : ""}: ${market.question}`);
        if (out.note) console.log(`\n${out.note}\n\n${out.links.join("\n")}`);
        for (const line of out.log) console.log(`  - ${line}`);
        break;
      }
      case "drafts": {
        const rows = app.db.prepare("SELECT id, market_id, stance, note FROM submissions WHERE status = 'draft'").all() as {
          id: number; market_id: string; stance: string; note: string;
        }[];
        if (!rows.length) console.log("No drafts waiting.");
        for (const r of rows) console.log(`#${r.id} ${r.stance} ${r.market_id}\n   ${r.note}\n`);
        break;
      }
      case "approve": {
        const row = await submitDraft(app.db, app.evidence, Number(args[0]), app.report);
        console.log(`Submitted #${row.id} as ${row.remote_id} (${row.status})`);
        break;
      }
      case "discard":
        discardDraft(app.db, Number(args[0]));
        console.log(`Discarded draft #${args[0]}`);
        break;
      case "poll":
        console.log(`Checked ${await pollSubmissions(app.db, app.evidence, app.report)} submissions`);
        break;
      case "cycle":
        console.log(await runCycle(app, { log: (l) => console.log(l) }));
        break;
      case "digest": {
        const now = new Date();
        const digest = buildDigest(app.db, new Date(now.getTime() - 86_400_000), now);
        console.log(`Saved ${saveDigest(digest, app.settings.reportsDir).markdown}`);
        if (args.includes("--send")) {
          const result = await deliverDigest(app.settings, {
            subject: `DelphiLens digest ${now.toISOString().slice(0, 10)}`,
            markdown: renderMarkdown(digest),
            html: renderHtml(digest),
          });
          console.log(`Discord: ${result.discord} | Email: ${result.email}`);
        }
        break;
      }
      case "feedback":
        console.log(`Saved ${exportFeedbackReport(app.db, app.settings.reportsDir)}`);
        break;
      case "terms": {
        const { data } = await app.evidence.getTerms();
        console.log(`Terms version ${data.version}: ${data.url}`);
        console.log(data.acceptedAt ? `Accepted at ${data.acceptedAt}` : "Not accepted yet.");
        const i = args.indexOf("--accept");
        if (i !== -1) {
          if (args[i + 1] !== data.version) throw new Error(`Pass the current version: --accept ${data.version}`);
          const res = await app.evidence.acceptTerms(data.version);
          console.log(`Accepted version ${res.data.version} at ${res.data.acceptedAt}`);
        } else if (!data.acceptedAt) {
          console.log(`Read the terms, then run: npm start -- terms --accept ${data.version}`);
        }
        break;
      }
      default:
        console.log(`Unknown command "${command}".\n\n${HELP}`);
        process.exitCode = 1;
    }
  } finally {
    app.db.close();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exitCode = 1;
});
