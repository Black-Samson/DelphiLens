import { describe, expect, it } from "vitest";
import {
  GuardrailError,
  checkSubmission,
  countSubmissions,
  createDraft,
  discardDraft,
  getLockedStance,
  markSubmitted,
  updateDraftNote,
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

  it("keeps a submission to 3 items: the note plus at most 2 links", () => {
    const db = testDb();
    const two = checkSubmission(db, { ...draft(1), links: ["https://a.gov/1", "https://a.gov/2"] });
    const three = checkSubmission(db, { ...draft(1), links: ["https://a.gov/1", "https://a.gov/2", "https://a.gov/3"] });
    expect(two).toEqual([]);
    expect(three.join()).toMatch(/Max 3 items per submission \(the note counts as one\), got 4/);
  });

  it("keeps at most 3 local snapshots per draft", () => {
    const db = testDb();
    expect(checkSubmission(db, { ...draft(1), files: ["a", "b", "c"] })).toEqual([]);
    expect(checkSubmission(db, { ...draft(1), files: ["a", "b", "c", "d"] }).join()).toMatch(/Max 3 snapshots/);
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

  it("lets you edit a draft's note, but not a sent one or into a duplicate", () => {
    const db = testDb();
    const a = createDraft(db, draft(1));
    const b = createDraft(db, draft(2));
    updateDraftNote(db, a, "Corrected note that matches the source.");
    expect((db.prepare("SELECT note FROM submissions WHERE id = ?").get(a) as { note: string }).note).toBe(
      "Corrected note that matches the source.",
    );
    expect(() => updateDraftNote(db, b, "corrected note that matches the source.")).toThrow(/Duplicate claim/);
    expect(() => updateDraftNote(db, b, "  ")).toThrow(/cannot be empty/);
    // The old wording is free again.
    expect(checkSubmission(db, { ...draft(9), note: "Unique dated claim number 1." }).join()).not.toMatch(/Duplicate claim/);
    markSubmitted(db, b, "remote");
    expect(() => updateDraftNote(db, b, "New text.")).toThrow(/not sent/);
  });
});
