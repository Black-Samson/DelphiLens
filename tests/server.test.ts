import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { startServer } from "../src/server";

let base = "";
let close: () => void;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srv-"));
  const make = () => {
    const app = createApp({ dbPath: path.join(dir, "test.db"), env: {} });
    app.settings = { ...app.settings, reportsDir: path.join(dir, "reports"), snapshotsDir: path.join(dir, "snaps") };
    // A little latency, like real search, so two requests can overlap.
    const search = app.search;
    app.search = {
      search: async (...args: Parameters<typeof search.search>) => {
        await new Promise((r) => setTimeout(r, 15));
        return search.search(...args);
      },
    };
    return app;
  };
  const server = startServer(0, make);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

const api = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(base + p, { method, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};

describe("dashboard api", () => {
  it("refreshes markets, mines one and approves the draft", async () => {
    expect((await api("POST", "/api/markets/refresh")).data.new).toBeGreaterThan(0);
    const markets = (await api("GET", "/api/markets")).data;
    expect(markets[0]).toMatchObject({ stance: "OPEN", used: 0 });
    const mined = (await api("POST", `/api/markets/${markets[0].marketId}/mine`)).data;
    expect(mined.status).toBe("draft_created");
    const approved = await api("POST", `/api/submissions/${mined.submissionId}/approve`);
    expect(approved.data.status).toBe("queued");
    const after = (await api("GET", "/api/markets")).data.find((m: { marketId: string }) => m.marketId === markets[0].marketId);
    expect(after).toMatchObject({ stance: mined.stance, used: 1 });
  });

  it("refuses a second mining run on a market that is already being mined", async () => {
    const markets = (await api("GET", "/api/markets")).data;
    const id = markets[3].marketId;
    const [a, b] = await Promise.all([api("POST", `/api/markets/${id}/mine`), api("POST", `/api/markets/${id}/mine`)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect([a, b].find((r) => r.status === 409)?.data.error).toMatch(/already being mined/);
  });

  it("reports state and flips runtime switches", async () => {
    const state = (await api("GET", "/api/state")).data;
    expect(state.modes.delphi).toBe("mock");
    expect(state.stats.qualification).toBeDefined();
    const flipped = (await api("POST", "/api/settings", { autoSubmit: true })).data;
    expect(flipped.autoSubmit).toBe(true);
    const refused = await api("POST", "/api/settings", { mockMode: false });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toMatch(/Live mode is on/);
    expect((await api("GET", "/api/state")).data.mockMode).toBe(true);
  });

  it("generates the digest and the feedback report", async () => {
    expect((await api("POST", "/api/digest")).data.file).toMatch(/^digest_/);
    expect((await api("POST", "/api/feedback", { kind: "note", detail: "Cutoff time zone unclear" })).status).toBe(200);
    expect((await api("POST", "/api/feedback", {})).status).toBe(400);
    expect((await api("POST", "/api/feedback/export")).data.markdown).toContain("Cutoff time zone unclear");
  });

  it("returns 404s and never serves files outside its folders", async () => {
    expect((await api("GET", "/api/nope")).status).toBe(404);
    expect((await fetch(`${base}/snapshots/..%2F..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${base}/../package.json`)).status).toBe(404);
  });
});
