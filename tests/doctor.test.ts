import { EvidenceApiError } from "@gensyn-ai/gensyn-delphi-sdk";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { formatChecks, runDoctor } from "../src/doctor";
import { MockEvidenceApi } from "../src/evidence/mock";

const LIVE = {
  MOCK_MODE: "false",
  DELPHI_API_ACCESS_KEY: "secret-key-123",
  SEARCH_API_KEY: "s",
  LLM_API_KEY: "l",
  MARKETS_SOURCE: "mock",
};

function liveApp(env: Record<string, string> = {}) {
  const app = createApp({ dbPath: ":memory:", env: { ...LIVE, ...env } });
  app.evidence = new MockEvidenceApi(0);
  // fetchMarkets reads settings.marketsSource; "mock" keeps this test offline.
  app.settings = { ...app.settings, marketsSource: "mock" };
  return app;
}

describe("doctor", () => {
  it("stops after the mode check in mock mode", async () => {
    const checks = await runDoctor(createApp({ dbPath: ":memory:", env: {} }));
    expect(checks.map((c) => c.name)).toEqual(["Mode", "Research"]);
    expect(checks[0].ok).toBe(false);
  });

  it("passes every check for a working live setup", async () => {
    const checks = await runDoctor(liveApp({ DELPHI_WALLET: "0x" + "a".repeat(40) }));
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(formatChecks(checks)).toContain("submissions left this hour");
    expect(formatChecks(checks)).not.toContain("secret-key-123");
  });

  it.each([
    [401, /MAINNET key/],
    [404, /registered on DoraHacks/],
  ])("explains a %s from /v1/limits", async (status, message) => {
    const app = liveApp();
    vi.spyOn(app.evidence, "getLimits").mockRejectedValue(new EvidenceApiError(status, "x", "x", false, null, null));
    const checks = await runDoctor(app);
    expect(checks.at(-1)?.detail).toMatch(message);
    expect(checks.at(-1)?.ok).toBe(false);
  });

  it("flags unaccepted terms and a missing wallet", async () => {
    const app = liveApp();
    vi.spyOn(app.evidence, "getTerms").mockResolvedValue({ data: { version: "v3", url: "https://t", acceptedAt: null }, meta: {} });
    const text = formatChecks(await runDoctor(app));
    expect(text).toMatch(/FIX {2}Terms .*terms --accept v3/);
    expect(text).toMatch(/FIX {2}Feedback wallet/);
  });
});
