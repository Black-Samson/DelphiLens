import { describe, expect, it } from "vitest";
import { countSubmissions, getLockedStance, isStance, lockStance } from "../src/guardrails";
import { insertSubmission, testDb } from "./helpers";

describe("stance lock", () => {
  it("is open until something is drafted or locked", () => {
    expect(getLockedStance(testDb(), "M1")).toBeNull();
  });

  it("follows the first non-discarded submission", () => {
    const db = testDb();
    insertSubmission(db, "M1", "NO", "discarded");
    insertSubmission(db, "M1", "YES");
    expect(getLockedStance(db, "M1")).toBe("YES");
  });

  it("prefers an explicit lock and never changes it", () => {
    const db = testDb();
    lockStance(db, "M1", "NO");
    lockStance(db, "M1", "YES");
    insertSubmission(db, "M1", "YES");
    expect(getLockedStance(db, "M1")).toBe("NO");
  });

  it("is tracked per market", () => {
    const db = testDb();
    lockStance(db, "M1", "YES");
    lockStance(db, "M2", "NO");
    expect([getLockedStance(db, "M1"), getLockedStance(db, "M2")]).toEqual(["YES", "NO"]);
  });

  it("validates stance values", () => {
    expect(isStance("YES")).toBe(true);
    expect(isStance("yes")).toBe(false);
    expect(isStance("MAYBE")).toBe(false);
  });
});

describe("submission counting", () => {
  it("ignores discarded drafts", () => {
    const db = testDb();
    insertSubmission(db, "M1", "YES");
    insertSubmission(db, "M1", "YES", "discarded");
    insertSubmission(db, "M1", "YES", "judged");
    expect(countSubmissions(db, "M1")).toBe(2);
  });
});
