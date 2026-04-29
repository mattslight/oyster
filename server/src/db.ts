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

  // Add the artifacts.source_id FK *after* the sources table exists. SQLite
  // tolerates forward FK references at ALTER time (the FK only validates at
  // write time), but explicit ordering is less surprising.
  // ON DELETE SET NULL covers the rare case where a space is hard-deleted —
  // cascade hard-deletes its sources via sources.space_id, and artifacts
  // left behind become unattributed orphans rather than dangling FKs.
  try {
    db.exec("ALTER TABLE artifacts ADD COLUMN source_id TEXT REFERENCES sources(id) ON DELETE SET NULL");
  } catch { /* already exists */ }

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

  // Sessions arc (0.5.0). Three tables that capture agent activity (claude-code,
  // opencode, codex) read from external session logs. See
  // docs/plans/sessions-arc.md for the design.
  //
  // - sessions.space_id is nullable + ON DELETE SET NULL: sessions whose CWD
  //   doesn't match a registered space's source path land as orphans (no space
  //   badge on Home), and deleting a space leaves its sessions intact rather
  //   than cascading. Mirrors the artifacts.source_id pattern above.
  // - session_events / session_artifacts cascade on session deletion so we
  //   don't leak transcript rows when a session is reaped.
  // - session_artifacts uses a surrogate INTEGER id (not a composite key on
  //   when_at) because datetime('now') is only second-precise — two same-role
  //   touches in the same second would have collided. Lookups go through the
  //   two indexes below.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      space_id      TEXT REFERENCES spaces(id) ON DELETE SET NULL,
      agent         TEXT NOT NULL CHECK (agent IN ('claude-code','opencode','codex')),
      title         TEXT,
      state         TEXT NOT NULL CHECK (state IN ('active','waiting','disconnected','done')),
      started_at    TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at      TEXT,
      model         TEXT,
      last_event_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS sessions_space_id ON sessions(space_id);
    CREATE INDEX IF NOT EXISTS sessions_state_last_event
      ON sessions(state, last_event_at);

    CREATE TABLE IF NOT EXISTS session_events (
      id         INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('user','assistant','tool','tool_result','system')),
      text       TEXT NOT NULL,
      ts         TEXT NOT NULL DEFAULT (datetime('now')),
      raw        TEXT
    );
    CREATE INDEX IF NOT EXISTS session_events_session_ts
      ON session_events(session_id, ts);

    CREATE TABLE IF NOT EXISTS session_artifacts (
      id          INTEGER PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      role        TEXT NOT NULL CHECK (role IN ('create','modify','read')),
      when_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS session_artifacts_session
      ON session_artifacts(session_id, when_at);
    CREATE INDEX IF NOT EXISTS session_artifacts_artifact
      ON session_artifacts(artifact_id);
  `);

  // ── Sessions state-rename migration (running/awaiting → active/waiting) ──
  // SQLite can't ALTER a CHECK constraint, so we rebuild via temp table.
  //
  // Two trigger conditions:
  //   (a) sessions table SQL still contains the old CHECK constraint
  //       ('running'/'awaiting') — pre-migration.
  //   (b) session_events / session_artifacts FK references point at
  //       "sessions_old" — half-migrated state from an earlier broken
  //       version of this migration that used `RENAME TO sessions_old`
  //       and let SQLite auto-rewrite the dependent FKs to that phantom
  //       name. Detect either; both paths run the same rebuild.
  //
  // The rebuild is idempotent — once dependent FKs reference 'sessions'
  // and the CHECK lists the new state names, neither condition fires.
  const tableSql = (name: string): string =>
    (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as { sql: string } | undefined)?.sql ?? "";

  const sessionsSql = tableSql("sessions");
  const eventsSql = tableSql("session_events");
  const artifactsSql = tableSql("session_artifacts");
  const needsMigrate =
    sessionsSql.includes("'running'") ||
    eventsSql.includes("sessions_old") ||
    artifactsSql.includes("sessions_old");

  if (needsMigrate) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN TRANSACTION;

      -- 1. Rebuild sessions with the new CHECK constraint and remap states.
      CREATE TABLE _sessions_new (
        id            TEXT PRIMARY KEY,
        space_id      TEXT REFERENCES spaces(id) ON DELETE SET NULL,
        agent         TEXT NOT NULL CHECK (agent IN ('claude-code','opencode','codex')),
        title         TEXT,
        state         TEXT NOT NULL CHECK (state IN ('active','waiting','disconnected','done')),
        started_at    TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at      TEXT,
        model         TEXT,
        last_event_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO _sessions_new (id, space_id, agent, title, state, started_at, ended_at, model, last_event_at)
        SELECT id, space_id, agent, title,
          CASE state WHEN 'running' THEN 'active' WHEN 'awaiting' THEN 'waiting' ELSE state END,
          started_at, ended_at, model, last_event_at
        FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE _sessions_new RENAME TO sessions;
      CREATE INDEX IF NOT EXISTS sessions_space_id ON sessions(space_id);
      CREATE INDEX IF NOT EXISTS sessions_state_last_event ON sessions(state, last_event_at);

      -- 2. Rebuild session_events so its FK points at the new sessions table.
      CREATE TABLE _session_events_new (
        id         INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role       TEXT NOT NULL CHECK (role IN ('user','assistant','tool','tool_result','system')),
        text       TEXT NOT NULL,
        ts         TEXT NOT NULL DEFAULT (datetime('now')),
        raw        TEXT
      );
      -- ORDER BY id preserves chronological order. The new table assigns
      -- fresh INTEGER PRIMARY KEY values; without the ORDER BY, the post-
      -- migration getEventsBySession (which orders by id) could return
      -- events out of order, scrambling the transcript.
      INSERT INTO _session_events_new (session_id, role, text, ts, raw)
        SELECT session_id, role, text, ts, raw FROM session_events ORDER BY id;
      DROP TABLE session_events;
      ALTER TABLE _session_events_new RENAME TO session_events;
      CREATE INDEX IF NOT EXISTS session_events_session_ts ON session_events(session_id, ts);

      -- 3. Same for session_artifacts.
      CREATE TABLE _session_artifacts_new (
        id          INTEGER PRIMARY KEY,
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        role        TEXT NOT NULL CHECK (role IN ('create','modify','read')),
        when_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO _session_artifacts_new (session_id, artifact_id, role, when_at)
        SELECT session_id, artifact_id, role, when_at FROM session_artifacts ORDER BY when_at;
      DROP TABLE session_artifacts;
      ALTER TABLE _session_artifacts_new RENAME TO session_artifacts;
      CREATE INDEX IF NOT EXISTS session_artifacts_session ON session_artifacts(session_id, when_at);
      CREATE INDEX IF NOT EXISTS session_artifacts_artifact ON session_artifacts(artifact_id);

      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

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
