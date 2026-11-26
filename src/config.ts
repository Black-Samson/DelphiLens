import "dotenv/config";
import dns from "node:dns";
import path from "node:path";
import { fileURLToPath } from "node:url";

// WSL and some home networks advertise IPv6 but cannot route it, so connections
// hang until they time out. Trying IPv4 addresses first avoids that.
dns.setDefaultResultOrder("ipv4first");

/** The agent identity is locked: it is sent as X-Agent-Id on every Delphi request. */
export const AGENT_ID = "DelphiLens";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type MarketsSource = "mock" | "sdk" | "url";

/** Published in the competition guide (competition.delphi.fyi/participate). */
export const DELPHI_EVIDENCE_BASE_URL = "https://delphi.fyi/v1";
export const COMPETITION_MARKETS_URL = "https://competition.delphi.fyi/markets.json";
export const FEEDBACK_URL = "https://feedback.delphi.fyi/v1/feedback";

export interface Settings {
  agentId: string;
  agentHarness: string;
  agentModel: string;
  mockMode: boolean;
  autoSubmit: boolean;
  delphiApiKey: string;
  /** The wallet the API key was created with. Needed only to send feedback. */
  delphiWallet: string;
  delphiNetwork: string;
  evidenceBaseUrl: string;
  marketsSource: MarketsSource;
  marketsUrl: string;
  searchApiKey: string;
  githubToken: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  maxSourceAgeDays: number;
  workerIntervalMinutes: number;
  marketPollMinutes: number;
  dashboardPort: number;
  discordWebhookUrl: string;
  smtp: { host: string; port: number; user: string; password: string; from: string; to: string };
  dbPath: string;
  snapshotsDir: string;
  reportsDir: string;
}

type Env = Record<string, string | undefined>;

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Header values must be 1 to 64 printable ASCII characters (Evidence API rule). */
export function headerSafe(value: string, fallback: string): string {
  const clean = value.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 64);
  return clean || fallback;
}

export function loadSettings(env: Env = process.env): Settings {
  const agentId = env.AGENT_ID?.trim() || AGENT_ID;
  if (agentId !== AGENT_ID) {
    throw new Error(`AGENT_ID is locked to "${AGENT_ID}", got "${agentId}"`);
  }
  const mockMode = flag(env.MOCK_MODE, true);
  const source = (env.MARKETS_SOURCE?.trim() || "url") as MarketsSource;
  if (!["mock", "sdk", "url"].includes(source)) {
    throw new Error(`MARKETS_SOURCE must be mock, sdk or url, got "${source}"`);
  }
  const dataDir = path.join(ROOT, "data");
  return {
    agentId,
    agentHarness: headerSafe(env.AGENT_HARNESS ?? "", "DelphiLens"),
    agentModel: headerSafe(env.AGENT_MODEL || env.LLM_MODEL || "", "unknown"),
    mockMode,
    autoSubmit: flag(env.AUTO_SUBMIT, false),
    delphiApiKey: (env.DELPHI_API_ACCESS_KEY || env.DELPHI_API_KEY || "").trim(),
    delphiWallet: (env.DELPHI_WALLET ?? "").trim(),
    delphiNetwork: env.DELPHI_NETWORK?.trim() || "mainnet",
    evidenceBaseUrl: (env.DELPHI_EVIDENCE_BASE_URL?.trim() || DELPHI_EVIDENCE_BASE_URL).replace(/\/+$/, ""),
    marketsSource: mockMode ? "mock" : source,
    marketsUrl: env.MARKETS_URL?.trim() || COMPETITION_MARKETS_URL,
    searchApiKey: env.SEARCH_API_KEY ?? "",
    githubToken: (env.GITHUB_TOKEN ?? "").trim(),
    llmBaseUrl: (env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""),
    llmApiKey: env.LLM_API_KEY ?? "",
    llmModel: env.LLM_MODEL?.trim() || "gpt-4o-mini",
    maxSourceAgeDays: int(env.MAX_SOURCE_AGE_DAYS, 3),
    workerIntervalMinutes: int(env.WORKER_INTERVAL_MINUTES, 30),
    marketPollMinutes: Math.max(1, int(env.MARKET_POLL_MINUTES, 5)),
    dashboardPort: int(env.DASHBOARD_PORT, 8501),
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL ?? "",
    smtp: {
      host: env.SMTP_HOST ?? "",
      port: int(env.SMTP_PORT, 587),
      user: env.SMTP_USER ?? "",
      password: env.SMTP_PASSWORD ?? "",
      from: env.DIGEST_EMAIL_FROM || env.SMTP_USER || "",
      to: env.DIGEST_EMAIL_TO ?? "",
    },
    dbPath: path.join(dataDir, "delphilens.db"),
    snapshotsDir: path.join(dataDir, "snapshots"),
    reportsDir: path.join(ROOT, "reports"),
  };
}

/** The headers the SDK sends for us: X-Agent-Id, X-Agent-Harness, X-Agent-Model. */
export function agentIdentity(settings: Settings) {
  return {
    agentId: settings.agentId,
    agentHarness: settings.agentHarness,
    agentModel: settings.agentModel,
  };
}
