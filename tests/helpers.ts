import { openDb, type DB } from "../src/db";

export function testDb(markets: string[] = ["M1", "M2", "M3", "M4"]): DB {
  const db = openDb(":memory:");
  const insert = db.prepare("INSERT INTO markets (market_id, question) VALUES (?, ?)");
  for (const id of markets) insert.run(id, `Question ${id}?`);
  return db;
}

export function insertSubmission(db: DB, marketId: string, stance: "YES" | "NO", status = "draft"): number {
  const info = db
    .prepare("INSERT INTO submissions (market_id, stance, note, status) VALUES (?, ?, ?, ?)")
    .run(marketId, stance, `note ${Math.random()}`, status);
  return Number(info.lastInsertRowid);
}
