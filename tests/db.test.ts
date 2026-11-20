import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";

describe("database", () => {
  it("creates every table", () => {
    const db = openDb(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => (row as { name: string }).name)
      .sort();
    expect(tables).toEqual(["claim_hashes", "feedback", "markets", "stance_locks", "submissions"]);
  });

  it("rejects a stance that is not YES or NO", () => {
    const db = openDb(":memory:");
    expect(() =>
      db.prepare("INSERT INTO stance_locks (market_id, stance) VALUES ('m', 'MAYBE')").run(),
    ).toThrow();
  });

  it("can be opened twice without losing data", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO markets (market_id, question) VALUES ('m1', 'Q?')").run();
    db.exec("SELECT 1");
    expect(db.prepare("SELECT COUNT(*) AS c FROM markets").get()).toEqual({ c: 1 });
  });
});
