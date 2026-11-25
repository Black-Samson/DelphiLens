import { EvidenceClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/config";
import { createEvidenceApi } from "../src/evidence/client";
import { MockEvidenceApi } from "../src/evidence/mock";

describe("evidence client factory", () => {
  it("uses the mock in mock mode", () => {
    expect(createEvidenceApi(loadSettings({}))).toBeInstanceOf(MockEvidenceApi);
  });

  it("needs a key and a /v1 base url in live mode", () => {
    expect(() => createEvidenceApi(loadSettings({ MOCK_MODE: "false" }))).toThrow(/DELPHI_API_ACCESS_KEY/);
    expect(createEvidenceApi(loadSettings({ MOCK_MODE: "false", DELPHI_API_ACCESS_KEY: "k" }))).toBeDefined();
    expect(() =>
      createEvidenceApi(
        loadSettings({ MOCK_MODE: "false", DELPHI_API_ACCESS_KEY: "k", DELPHI_EVIDENCE_BASE_URL: "https://x" }),
      ),
    ).toThrow(/\/v1/);
  });

  it("builds the SDK client, which sends the agent identity headers", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const settings = loadSettings({
      MOCK_MODE: "false",
      DELPHI_API_ACCESS_KEY: "secret",
      DELPHI_EVIDENCE_BASE_URL: "https://delphi.example/v1/",
      AGENT_MODEL: "gpt-4o-mini",
    });
    const api = createEvidenceApi(settings);
    expect(api).toBeInstanceOf(EvidenceClient);

    // Same constructor arguments, with a fake fetch, to check what goes on the wire.
    const probe = new EvidenceClient({
      baseUrl: settings.evidenceBaseUrl,
      apiKey: settings.delphiApiKey,
      agentId: settings.agentId,
      agentHarness: settings.agentHarness,
      agentModel: settings.agentModel,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string> });
        return new Response(JSON.stringify({ submitsLeftThisHour: 1, hourEndsAt: "", dailyCapLeft: 1, dailyCapResetAt: "" }), {
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    await probe.getLimits();
    expect(calls[0].url).toBe("https://delphi.example/v1/limits");
    expect(calls[0].headers).toMatchObject({
      Authorization: "Bearer secret",
      "X-Agent-Id": "DelphiLens",
      "X-Agent-Harness": "DelphiLens",
      "X-Agent-Model": "gpt-4o-mini",
    });
  });
});
