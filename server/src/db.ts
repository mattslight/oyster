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
  // FK enforcement is required for sources.space_id ON DELETE CASCADE and
  // artifacts.source_id ON DELETE SET NULL to actually fire.
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  for (const sql of [
    "ALTER TABLE artifacts ADD COLUMN group_name TEXT",
    "ALTER TABLE artifacts ADD COLUMN removed_at TEXT",
    "ALTER TABLE artifacts ADD COLUMN source_origin TEXT NOT NULL DEFAULT 'manual'",
    "ALTER TABLE artifacts ADD COLUMN source_ref TEXT",
    // #208: link discovered artifacts back to the source that produced them.
    // SET NULL covers the rare case where a space is hard-deleted (cascade
    // hard-deletes its sources via sources.space_id) — artifacts left behind
    // become unattributed orphans rather than dangling FKs.
    "ALTER TABLE artifacts ADD COLUMN source_id TEXT REFERENCES sources(id) ON DELETE SET NULL",
    "ALTER TABLE spaces ADD COLUMN parent_id TEXT REFERENCES spaces(id)",
    "ALTER TABLE spaces ADD COLUMN summary_title TEXT",
    "ALTER TABLE spaces ADD COLUMN summary_content TEXT",
  ]) {
    try { db.exec(sql); } catch { /* already exists */ }
  }

  // space_paths — legacy join table. Replaced by `sources` below (#208).
  // Kept for now so the existing migration block (lines below) can read
  // legacy spaces.repo_path data into it. Stops being written by the new
  // code path; can be dropped in a follow-up.
  db.exec(`
    CREATE TABLE IF NOT EXISTS space_paths (
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      path     TEXT NOT NULL,
      label    TEXT,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (space_id, path)
    )
  `);

  // sources — typed rows for external folders (and future cloud sources)
  // attached to a space. `removed_at` enables soft-delete cascade: detach
  // soft-deletes the source AND artifacts where source_id = ?, leaving the
  // FK chain intact and making reattach a simple "restore in place".
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id          TEXT PRIMARY KEY,
      space_id    TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      type        TEXT NOT NULL CHECK(type IN ('local_folder')),
      path        TEXT NOT NULL,
      label       TEXT,
      added_at    TEXT NOT NULL DEFAULT (datetime('now')),
      removed_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS sources_space_id ON sources(space_id);
    CREATE UNIQUE INDEX IF NOT EXISTS sources_path_active
      ON sources(path) WHERE removed_at IS NULL;
  `);

  // #208 ships as a manual one-shot migration for the maintainer's DB. No
  // other users currently have pre-#208 data (confirmed). Fresh installs
  // never populate `space_paths`. So no embedded upgrade backfill is needed —
  // if a user with old data ever surfaces, we'll do their migration by hand
  // (commit 4be6760 has the SQL).

  // Retire the legacy spaces.repo_path column. Fresh installs never had it
  // (removed from the SCHEMA above); existing installs get data migrated
  // into space_paths first, then the column dropped. Both statements
  // tolerate every combination: column present + populated, column present
  // + empty, column already gone, or SQLite < 3.35 (no DROP COLUMN support —
  // column stays, rest of the server still works since nothing reads it).
  try {
    db.exec(`
      INSERT OR IGNORE INTO space_paths (space_id, path)
      SELECT id, repo_path FROM spaces WHERE repo_path IS NOT NULL
    `);
  } catch { /* column already dropped */ }
  try { db.exec(`ALTER TABLE spaces DROP COLUMN repo_path`); } catch { /* already dropped, fresh install, or SQLite < 3.35 */ }

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
