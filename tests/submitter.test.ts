import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EvidenceApiError, TermsNotAcceptedError } from "@gensyn-ai/gensyn-delphi-sdk";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db";
import { MockEvidenceApi } from "../src/evidence/mock";
import { createDraft, getLockedStance } from "../src/guardrails";
import { getSubmissionRow, pollSubmissions, submitDraft, SubmitBlockedError } from "../src/submitter";

function setup(judgeDelayMs = 0) {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO markets (market_id, question) VALUES ('0xabc', 'Q?')").run();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sub-")), "snap.md");
  fs.writeFileSync(file, "# snapshot");
  const id = createDraft(db, {
    marketId: "0xabc",
    stance: "NO",
    note: "The regulator postponed the decision on Nov 21. The notice is public.",
    links: ["https://a.gov/r/1"],
    files: [file],
  });
  return { db, id, api: new MockEvidenceApi(judgeDelayMs) };
}

describe("submitter", () => {
  it("submits a draft with its files and locks the stance", async () => {
    const { db, id, api } = setup(60_000);
    const spy = vi.spyOn(api, "submitEvidence");
    const row = await submitDraft(db, api, id);
    expect(row.status).toBe("queued");
    expect(row.remote_id).toMatch(/^mock_0xabc_/);
    expect(row.idempotency_key).toBeTruthy();
    expect(getLockedStance(db, "0xabc")).toBe("NO");
    const params = spy.mock.calls[0][0];
    expect(params).toMatchObject({ marketAddress: "0xabc", links: ["https://a.gov/r/1"], idempotencyKey: row.idempotency_key });
    expect(params.files?.[0]).toBeInstanceOf(File);
    await expect(submitDraft(db, api, id)).rejects.toThrow(/not a draft/);
  });

  it("stores verdict, rationale and reward when polled", async () => {
    const { db, id, api } = setup(0);
    await submitDraft(db, api, id);
    await pollSubmissions(db, api);
    const row = getSubmissionRow(db, id);
    expect(row.status).toBe("judged");
    expect(["accepted", "rejected"]).toContain(row.verdict);
    expect(row.reason).toBeTruthy();
    expect(row.judged_at).toBeTruthy();
  });

  it("refuses when Delphi has no slots left on the market", async () => {
    const { db, id, api } = setup();
    vi.spyOn(api, "getEntryState").mockResolvedValue({
      data: { canSubmit: false, reason: "cap_reached", remainingOnMarket: 0, judgementPotRemainingBaseUnits: "0", rateLimit: { resetAt: "" } },
      meta: {},
    });
    await expect(submitDraft(db, api, id)).rejects.toThrow(SubmitBlockedError);
    expect(getSubmissionRow(db, id).status).toBe("draft");
  });

  it("refuses to resend a link this account already submitted", async () => {
    const { db, id, api } = setup();
    vi.spyOn(api, "listSubmissions").mockResolvedValue({
      data: { items: [{ links: ["https://a.gov/r/1/?utm_source=x"] } as never], nextCursor: null },
      meta: {},
    });
    await expect(submitDraft(db, api, id)).rejects.toThrow(/Already submitted/);
  });

  it("explains unaccepted terms without accepting them", async () => {
    const { db, id, api } = setup();
    vi.spyOn(api, "submitEvidence").mockRejectedValue(
      new TermsNotAcceptedError({ version: "v2", url: "https://t" }, 403, "terms_not_accepted", "x", false, null, null),
    );
    const accept = vi.spyOn(api, "acceptTerms");
    await expect(submitDraft(db, api, id)).rejects.toThrow(/terms --accept v2/);
    expect(accept).not.toHaveBeenCalled();
  });

  it("reports API errors and keeps the draft", async () => {
    const { db, id, api } = setup();
    vi.spyOn(api, "submitEvidence").mockRejectedValue(
      new EvidenceApiError(429, "rate_limited", "slow down", true, 30, null, "req-1", {}, "hourly"),
    );
    const issues: unknown[] = [];
    await expect(submitDraft(db, api, id, (...a) => issues.push(a))).rejects.toThrow(/slow down/);
    expect(issues[0]).toEqual(["api_error", "rate_limited: slow down", expect.objectContaining({ limit: "hourly" })]);
    const row = getSubmissionRow(db, id);
    expect(row.status).toBe("draft");
    expect(row.idempotency_key).toBeTruthy();
  });
});
