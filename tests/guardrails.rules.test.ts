import { describe, expect, it } from "vitest";
import {
  GuardrailError,
  checkSubmission,
  countSubmissions,
  createDraft,
  discardDraft,
  getLockedStance,
  markSubmitted,
} from "../src/guardrails";
import { testDb } from "./helpers";

const draft = (n: number, marketId = "M1", stance = "YES") => ({
  marketId,
  stance,
  note: `Unique dated claim number ${n}.`,
  links: [`https://agency.example.gov/release/${n}`],
});

describe("guardrails", () => {
  it("blocks evidence for the opposite side once a draft exists", () => {
    const db = testDb();
    createDraft(db, draft(1, "M1", "YES"));
    expect(() => createDraft(db, draft(2, "M1", "NO"))).toThrow(/locked to YES/);
    createDraft(db, draft(3, "M1", "YES"));
  });

  it("locks the stance permanently once submitted", () => {
    const db = testDb();
    const id = createDraft(db, draft(1, "M1", "NO"));
    markSubmitted(db, id, "remote-1");
    expect(getLockedStance(db, "M1")).toBe("NO");
    db.prepare("UPDATE submissions SET status = 'discarded'").run();
    expect(getLockedStance(db, "M1")).toBe("NO");
  });

  it("allows at most 3 submissions per market", () => {
    const db = testDb();
    for (const n of [1, 2, 3]) createDraft(db, draft(n));
    try {
      createDraft(db, draft(4));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GuardrailError);
      expect((err as GuardrailError).reasons.join()).toMatch(/Max 3 submissions/);
    }
    createDraft(db, draft(4, "M2"));
  });

  it("allows at most 3 files per submission", () => {
    const db = testDb();
    const three = checkSubmission(db, { ...draft(1), files: ["a", "b", "c"] });
    const four = checkSubmission(db, { ...draft(1), files: ["a", "b", "c", "d"] });
    expect(three).toEqual([]);
    expect(four.join()).toMatch(/Max 3 files/);
  });

  it("blocks a reused link, even with tracking params, across markets", () => {
    const db = testDb();
    createDraft(db, { ...draft(1), links: ["https://Example.com/a/"] });
    expect(() =>
      createDraft(db, { ...draft(2, "M2"), links: ["https://example.com/a?utm_source=x"] }),
    ).toThrow(/Duplicate source URL/);
  });

  it("blocks a repeated claim ignoring case and spacing", () => {
    const db = testDb();
    createDraft(db, { ...draft(1), note: "The agency  filed a rule." });
    expect(() => createDraft(db, { ...draft(2), note: "the AGENCY filed a rule." })).toThrow(
      /Duplicate claim/,
    );
  });

  it("requires a note and at least one link", () => {
    const db = testDb();
    const reasons = checkSubmission(db, { marketId: "M1", stance: "YES", note: " ", links: [] });
    expect(reasons.join()).toMatch(/note cannot be empty/);
    expect(reasons.join()).toMatch(/source link/);
  });

  it("frees the slot and hashes when a draft is discarded", () => {
    const db = testDb();
    const id = createDraft(db, draft(1));
    discardDraft(db, id);
    expect(countSubmissions(db, "M1")).toBe(0);
    expect(getLockedStance(db, "M1")).toBeNull();
    createDraft(db, draft(1, "M1", "NO"));
  });

  it("refuses to discard something already sent", () => {
    const db = testDb();
    const id = createDraft(db, draft(1));
    markSubmitted(db, id, "remote-1");
    expect(() => discardDraft(db, id)).toThrow(/not sent/);
  });
});
