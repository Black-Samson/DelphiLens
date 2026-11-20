import { describe, expect, it } from "vitest";
import { createApp, effectiveSettings } from "../src/app";
import { openDb, setRuntimeFlag } from "../src/db";
import { MockEvidenceApi } from "../src/evidence/mock";
import { listFeedback } from "../src/feedback";

describe("app wiring", () => {
  it("runs fully mocked by default", () => {
    const app = createApp({ dbPath: ":memory:", env: {} });
    expect(app.modes).toEqual({ delphi: "mock", search: "mock", llm: "mock" });
    expect(app.evidence).toBeInstanceOf(MockEvidenceApi);
  });

  it("uses real research providers in mock mode when keys are set", () => {
    const app = createApp({ dbPath: ":memory:", env: { SEARCH_API_KEY: "s", LLM_API_KEY: "l" } });
    expect(app.modes).toEqual({ delphi: "mock", search: "tavily", llm: "live" });
  });

  it("refuses live mode without real research providers", () => {
    const env = { MOCK_MODE: "false", DELPHI_API_ACCESS_KEY: "k", DELPHI_EVIDENCE_BASE_URL: "https://d/v1" };
    expect(() => createApp({ dbPath: ":memory:", env })).toThrow(/SEARCH_API_KEY and LLM_API_KEY/);
    const live = createApp({ dbPath: ":memory:", env: { ...env, SEARCH_API_KEY: "s", LLM_API_KEY: "l" } });
    expect(live.modes.delphi).toBe("live");
  });

  it("applies dashboard switches over .env", () => {
    const db = openDb(":memory:");
    expect(effectiveSettings(db, {}).autoSubmit).toBe(false);
    setRuntimeFlag(db, "autoSubmit", true);
    setRuntimeFlag(db, "mockMode", false);
    const s = effectiveSettings(db, { MOCK_MODE: "true" });
    expect(s).toMatchObject({ autoSubmit: true, mockMode: false });
  });

  it("logs issues to the feedback table", () => {
    const app = createApp({ dbPath: ":memory:", env: {} });
    app.report("tool_limitation", "Cannot read PDFs yet");
    expect(listFeedback(app.db)[0].detail).toBe("Cannot read PDFs yet");
  });
});
