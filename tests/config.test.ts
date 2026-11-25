import { describe, expect, it } from "vitest";
import { AGENT_ID, agentIdentity, headerSafe, loadSettings } from "../src/config";

describe("config", () => {
  it("locks the agent id to DelphiLens", () => {
    expect(AGENT_ID).toBe("DelphiLens");
    expect(loadSettings({}).agentId).toBe("DelphiLens");
    expect(() => loadSettings({ AGENT_ID: "SomethingElse" })).toThrow(/locked/);
  });

  it("defaults to mock mode with manual approval", () => {
    const s = loadSettings({});
    expect(s.mockMode).toBe(true);
    expect(s.autoSubmit).toBe(false);
    expect(s.marketsSource).toBe("mock");
  });

  it("uses the configured market source when mock mode is off", () => {
    const s = loadSettings({ MOCK_MODE: "false", MARKETS_SOURCE: "url" });
    expect(s.marketsSource).toBe("url");
    expect(() => loadSettings({ MARKETS_SOURCE: "ftp" })).toThrow();
  });

  it("builds identity headers that fit the 64 printable ASCII rule", () => {
    const s = loadSettings({ AGENT_MODEL: "model-é".padEnd(80, "x") });
    const id = agentIdentity(s);
    expect(id.agentId).toBe("DelphiLens");
    expect(id.agentModel.length).toBeLessThanOrEqual(64);
    expect(/^[\x20-\x7e]+$/.test(id.agentModel)).toBe(true);
    expect(headerSafe("   ", "fallback")).toBe("fallback");
  });

  it("defaults to the live competition endpoints from the guide", () => {
    const s = loadSettings({ MOCK_MODE: "false" });
    expect(s.evidenceBaseUrl).toBe("https://delphi.fyi/v1");
    expect(s.marketsSource).toBe("url");
    expect(s.marketsUrl).toBe("https://competition.delphi.fyi/markets.json");
    expect(loadSettings({ DELPHI_EVIDENCE_BASE_URL: "https://x/v1/" }).evidenceBaseUrl).toBe("https://x/v1");
  });

  it("accepts the SDK key name and the older one", () => {
    expect(loadSettings({ DELPHI_API_ACCESS_KEY: "a" }).delphiApiKey).toBe("a");
    expect(loadSettings({ DELPHI_API_KEY: "b" }).delphiApiKey).toBe("b");
  });
});
