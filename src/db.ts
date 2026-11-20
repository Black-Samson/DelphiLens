import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS markets (
  market_id        TEXT PRIMARY KEY,
  question         TEXT NOT NULL,
  category         TEXT,
  yes_odds         REAL,
  close_time       TEXT,
  evidence_cutoff  TEXT,
  reward_pot       REAL DEFAULT 0,
  url              TEXT,
  status           TEXT DEFAULT 'open',
  first_seen_at    TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stance_locks (
  market_id  TEXT PRIMARY KEY,
  stance     TEXT NOT NULL CHECK (stance IN ('YES', 'NO')),
  locked_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS submissions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id          TEXT NOT NULL,
  stance             TEXT NOT NULL CHECK (stance IN ('YES', 'NO')),
  note               TEXT NOT NULL,
  links              TEXT NOT NULL DEFAULT '[]',
  files              TEXT NOT NULL DEFAULT '[]',
  confidence         REAL,
  status             TEXT NOT NULL DEFAULT 'draft',
  remote_id          TEXT,
  idempotency_key    TEXT,
  verdict            TEXT,
  reason             TEXT,
  reward_base_units  TEXT DEFAULT '0',
  bounty_state       TEXT,
  zero_pay_reason    TEXT,
  created_at         TEXT DEFAULT (datetime('now')),
  submitted_at       TEXT,
  judged_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_submissions_market ON submissions (market_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions (status);

CREATE TABLE IF NOT EXISTS claim_hashes (
  hash           TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('url', 'claim')),
  market_id      TEXT,
  submission_id  INTEGER,
  created_at     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  source      TEXT NOT NULL,
  detail      TEXT NOT NULL,
  context     TEXT NOT NULL DEFAULT '{}',
  fingerprint TEXT UNIQUE,
  count       INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now')),
  last_seen   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runtime_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;

/** Open (and create if needed) the DelphiLens database. Use ":memory:" in tests. */
export function openDb(dbPath: string): DB {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

/** Runtime switches set from the dashboard (they override .env until cleared). */
export function getRuntimeFlag(db: DB, key: string): boolean | null {
  const row = db.prepare("SELECT value FROM runtime_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value === "true" : null;
}

export function setRuntimeFlag(db: DB, key: string, value: boolean): void {
  db.prepare(
    "INSERT INTO runtime_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, String(value));
}
