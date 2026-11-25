import { EvidenceApiError } from "@gensyn-ai/gensyn-delphi-sdk";
import type { App } from "./app";
import { fetchMarkets } from "./markets/source";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The entry checks from the competition guide (competition.delphi.fyi/skill.md):
 * key works (GET /v1/limits), terms accepted (GET /v1/terms), markets listed.
 * Never prints the key.
 */
export async function runDoctor(app: App): Promise<Check[]> {
  const checks: Check[] = [];
  const s = app.settings;
  checks.push({
    name: "Mode",
    ok: !s.mockMode,
    detail: s.mockMode ? "Mock mode is on: nothing is sent to Delphi. Run: npm start -- mock off" : "Live mode",
  });
  checks.push({
    name: "Research",
    ok: app.modes.search !== "mock" && app.modes.llm !== "mock",
    detail: `search: ${app.modes.search}, LLM: ${app.modes.llm}`,
  });
  if (s.mockMode) return checks;

  try {
    const { data } = await app.evidence.getLimits();
    checks.push({
      name: "API key",
      ok: true,
      detail: `Accepted. ${data.submitsLeftThisHour} submissions left this hour (resets ${data.hourEndsAt}), daily reward cap left: ${data.dailyCapLeft}.`,
    });
  } catch (err) {
    const status = err instanceof EvidenceApiError ? err.status : 0;
    const detail =
      status === 401
        ? "Key rejected (401). Create a MAINNET key at https://api-access.delphi.fyi, signed in the same way you sign in to Delphi, and put it in DELPHI_API_ACCESS_KEY."
        : status === 404
          ? "No evidence access yet (404). Either you have not registered on DoraHacks with the wallet shown on your Delphi profile, or you registered in the last hour (access syncs once an hour)."
          : `Could not reach Delphi: ${(err as Error).message}`;
    checks.push({ name: "API key", ok: false, detail });
    return checks;
  }

  try {
    const { data } = await app.evidence.getTerms();
    checks.push({
      name: "Terms",
      ok: Boolean(data.acceptedAt),
      detail: data.acceptedAt
        ? `Version ${data.version} accepted ${data.acceptedAt}`
        : `Not accepted. Read ${data.url}, then run: npm start -- terms --accept ${data.version}`,
    });
  } catch (err) {
    checks.push({ name: "Terms", ok: false, detail: (err as Error).message });
  }

  try {
    const markets = await fetchMarkets(s);
    checks.push({
      name: "Markets",
      ok: markets.length > 0,
      detail: markets.length ? `${markets.length} open competition markets` : "The market list is empty: no market is open yet",
    });
  } catch (err) {
    checks.push({ name: "Markets", ok: false, detail: (err as Error).message });
  }

  checks.push({
    name: "Feedback wallet",
    ok: /^0x[0-9a-fA-F]{40}$/.test(s.delphiWallet),
    detail: s.delphiWallet ? "Set" : "DELPHI_WALLET is empty: needed only to send feedback for the bounties",
  });
  return checks;
}

export function formatChecks(checks: Check[]): string {
  return checks.map((c) => `${c.ok ? "OK  " : "FIX "} ${c.name.padEnd(16)} ${c.detail}`).join("\n");
}
