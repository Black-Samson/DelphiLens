import { loadSettings, type Settings } from "./config";
import { getRuntimeFlag, openDb, type DB } from "./db";
import { createEvidenceApi } from "./evidence/client";
import type { EvidenceApi } from "./evidence/types";
import { logFeedback } from "./feedback";
import { LiveFetcher, MockFetcher, type PageFetcher } from "./research/fetcher";
import { MockLLM, OpenAICompatibleLLM, type LLMProvider } from "./research/llm";
import type { MinerDeps } from "./research/miner";
import { MockSearchProvider, TavilySearchProvider, type SearchProvider } from "./research/search";
import type { IssueReporter } from "./submitter";

export interface App {
  settings: Settings;
  db: DB;
  evidence: EvidenceApi;
  search: SearchProvider;
  llm: LLMProvider;
  fetcher: PageFetcher;
  report: IssueReporter;
  /** Labels for the dashboard: which parts are real and which are mocked. */
  modes: { delphi: "mock" | "live"; search: "mock" | "tavily"; llm: "mock" | "live" };
}

/** .env settings with the dashboard's runtime switches applied on top. */
export function effectiveSettings(db: DB, env: Record<string, string | undefined> = process.env): Settings {
  const mock = getRuntimeFlag(db, "mockMode");
  const auto = getRuntimeFlag(db, "autoSubmit");
  const settings = loadSettings(mock === null ? env : { ...env, MOCK_MODE: String(mock) });
  return auto === null ? settings : { ...settings, autoSubmit: auto };
}

/**
 * Wire everything together.
 * Mock mode may use real search and LLM keys if you set them (useful to test research
 * before Nov 23). Live mode refuses to start without them, so DelphiLens can never
 * send made-up mock evidence to the real competition.
 */
export function createApp(options: { dbPath?: string; env?: Record<string, string | undefined> } = {}): App {
  const env = options.env ?? process.env;
  const db = openDb(options.dbPath ?? loadSettings(env).dbPath);
  const settings = effectiveSettings(db, env);

  if (!settings.mockMode) {
    const missing = [!settings.searchApiKey && "SEARCH_API_KEY", !settings.llmApiKey && "LLM_API_KEY"].filter(Boolean);
    if (missing.length) {
      db.close();
      throw new Error(`Live mode needs ${missing.join(" and ")} in .env (mock research is never used for real submissions)`);
    }
  }

  const search = settings.searchApiKey
    ? new TavilySearchProvider(settings.searchApiKey, settings.maxSourceAgeDays)
    : new MockSearchProvider();
  const llm = settings.llmApiKey
    ? new OpenAICompatibleLLM(settings.llmBaseUrl, settings.llmApiKey, settings.llmModel)
    : new MockLLM();
  const fetcher = search instanceof MockSearchProvider ? new MockFetcher() : new LiveFetcher();

  return {
    settings,
    db,
    evidence: createEvidenceApi(settings),
    search,
    llm,
    fetcher,
    report: (kind, detail, context) => logFeedback(db, kind, detail, context),
    modes: {
      delphi: settings.mockMode ? "mock" : "live",
      search: search instanceof MockSearchProvider ? "mock" : "tavily",
      llm: llm instanceof MockLLM ? "mock" : "live",
    },
  };
}

export function minerDeps(app: App): MinerDeps {
  return {
    search: app.search,
    llm: app.llm,
    fetcher: app.fetcher,
    snapshotsDir: app.settings.snapshotsDir,
    maxAgeDays: app.settings.maxSourceAgeDays,
    onIssue: app.report,
  };
}
