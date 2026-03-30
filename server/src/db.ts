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

CREATE TABLE IF NOT EXISTS spaces (
  id                TEXT PRIMARY KEY,
  display_name      TEXT NOT NULL,
  repo_path         TEXT UNIQUE,
  color             TEXT,
  scan_status       TEXT NOT NULL DEFAULT 'none'
    CHECK (scan_status IN ('none','scanning','complete','error')),
  scan_error        TEXT,
  last_scanned_at   TEXT,
  last_scan_summary TEXT,
  ai_job_status     TEXT
    CHECK (ai_job_status IS NULL OR ai_job_status IN ('pending','running','complete','error')),
  ai_job_error      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function initDb(userlandDir: string): Database.Database {
  const dbPath = join(userlandDir, "oyster.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  for (const sql of [
    "ALTER TABLE artifacts ADD COLUMN group_name TEXT",
    "ALTER TABLE artifacts ADD COLUMN removed_at TEXT",
    "ALTER TABLE artifacts ADD COLUMN source_origin TEXT NOT NULL DEFAULT 'manual'",
    "ALTER TABLE artifacts ADD COLUMN source_ref TEXT",
    "ALTER TABLE spaces ADD COLUMN parent_id TEXT REFERENCES spaces(id)",
  ]) {
    try { db.exec(sql); } catch { /* already exists */ }
  }

  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS artifacts_space_source_ref_uq
        ON artifacts(space_id, source_ref)
        WHERE source_ref IS NOT NULL
    `);
  } catch { /* already exists */ }

  // One-time seed: populate spaces from artifact space_ids only if the table is empty.
  // Using INSERT OR IGNORE on an existing table would resurrect deleted spaces on restart.
  const spaceCount = (db.prepare("SELECT COUNT(*) as n FROM spaces").get() as { n: number }).n;
  if (spaceCount === 0) {
    db.exec(`
      INSERT OR IGNORE INTO spaces (id, display_name, created_at, updated_at)
      SELECT DISTINCT space_id, space_id, datetime('now'), datetime('now')
      FROM artifacts
      WHERE space_id IS NOT NULL AND space_id != ''
        AND removed_at IS NULL
    `);
  }

  return db;
}
