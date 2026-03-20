import Database from "better-sqlite3";
import { join } from "node:path";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS artifacts (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT,
  space_id       TEXT NOT NULL,
  label          TEXT NOT NULL,
  artifact_kind  TEXT NOT NULL,
  storage_kind   TEXT NOT NULL,
  storage_config TEXT NOT NULL DEFAULT '{}',
  runtime_kind   TEXT NOT NULL,
  runtime_config TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function initDb(userlandDir: string): Database.Database {
  const dbPath = join(userlandDir, "oyster.db");
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  return db;
}
