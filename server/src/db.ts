import Database from "better-sqlite3";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolveArtifactPathViaProjects, findProjectAtAncestor } from "./resolve-artifact-path.js";

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
  const initT0 = performance.now();
  const dbPath = join(userlandDir, "oyster.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  // FK enforcement is required for projects.space_id ON DELETE CASCADE to fire.
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
    "ALTER TABLE spaces ADD COLUMN sync_dirty_at INTEGER",
    "ALTER TABLE spaces ADD COLUMN cloud_synced_at INTEGER",
    "ALTER TABLE spaces ADD COLUMN deleted_at INTEGER",
  ]) {
    try { db.exec(sql); } catch { /* already exists */ }
  }

  // Promotion backfill: pre-existing local rows (created before sync existed,
  // or while the user was on the free tier) need to be pushed up on first Pro
  // sign-in. Mark them dirty exactly once by setting sync_dirty_at where it's
  // still NULL AND there's no cloud_synced_at yet — i.e. truly never-synced
  // local rows. This explicitly excludes rows freshly pulled from the cloud
  // (which have cloud_synced_at set but sync_dirty_at=NULL by design); marking
  // those dirty would cause a spurious push on next reconcile that could
  // overwrite a peer's legitimate edit via LWW.
  // Excludes tombstones via deleted_at IS NULL.
  db.exec(`
    UPDATE spaces
       SET sync_dirty_at = CAST(strftime('%s','now') AS INTEGER) * 1000
     WHERE sync_dirty_at IS NULL
       AND cloud_synced_at IS NULL
       AND deleted_at IS NULL
  `);

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

  // R5 publish & share (#314). Turn an artifact into a shareable URL.
  // share_token gets a UNIQUE index in a separate statement — SQLite
  // ADD COLUMN doesn't allow UNIQUE inline. NULL tokens are treated as
  // distinct under SQL UNIQUE, so unpublished rows coexist freely.
  // published_at / unpublished_at are INTEGER unix-ms per the ticket
  // (viewer Workers want Date.now() directly, no iso8601 round-trip).
  for (const sql of [
    "ALTER TABLE artifacts ADD COLUMN share_token TEXT",
    "ALTER TABLE artifacts ADD COLUMN share_mode TEXT CHECK (share_mode IS NULL OR share_mode IN ('open','password','signin'))",
    "ALTER TABLE artifacts ADD COLUMN share_password_hash TEXT",
    "ALTER TABLE artifacts ADD COLUMN published_at INTEGER",
    "ALTER TABLE artifacts ADD COLUMN share_updated_at INTEGER",
    "ALTER TABLE artifacts ADD COLUMN unpublished_at INTEGER",
  ]) {
    try { db.exec(sql); } catch { /* already exists */ }
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS artifacts_share_token_uq ON artifacts(share_token)");

  // Pinning (#387). NULL = unpinned; non-null INTEGER unix-ms = the moment
  // the user pinned the artefact, used to sort most-recently-pinned first.
  try { db.exec("ALTER TABLE artifacts ADD COLUMN pinned_at INTEGER"); } catch { /* already exists */ }

  // Profile binding (#318). Locks this local Oyster profile to one cloud
  // account on first Pro sign-in, preventing a second Pro user from pulling
  // their cloud data into the wrong local SQLite via cross-device sync.
  // CHECK (id = 1) enforces at most one row — no separate UNIQUE index needed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_binding (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      cloud_owner_id  TEXT    NOT NULL,
      bound_at        INTEGER NOT NULL
    )
  `);

  // Device identity (#322 session sync). Stable per-device id + label so cloud
  // metadata can attribute "this session originated on Matthew's MacBook Pro".
  // Singleton like profile_binding. The seeding helper (uuid + os.hostname()
  // derivation) lands in PR 1b alongside SessionSyncService wiring; this
  // table is created up-front so the migration sits with the other singletons.
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_identity (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      device_id  TEXT    NOT NULL,
      label      TEXT    NOT NULL
    )
  `);

  // Cross-device session metadata mirror (#322 PR 2). Populated by
  // SessionSyncService.pull() from the cloud worker's GET
  // /api/sessions/metadata. Kept in a SEPARATE table from `sessions` so
  // foreign devices' data never contaminates the local watcher's source
  // of truth: the watcher writes only to `sessions`; the pull layer
  // writes only here. The Home / sessions list view merges both for
  // display via routes/sessions.ts.
  //
  // jsonl_local_path is set once a Device-B "Resume on this device"
  // reassembles the chunks to disk. Subsequent resumes can short-circuit
  // and just surface the existing local path.
  //
  // has_bytes mirrors the cloud manifest's "is there a chunk for this
  // session in the current generation" — gates whether the Resume button
  // can even fire (no bytes → only metadata is available, no transcript).
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_sessions (
      session_id        TEXT    NOT NULL,
      owner_id          TEXT    NOT NULL,
      device_id         TEXT,
      agent             TEXT    NOT NULL,
      title             TEXT,
      state             TEXT    NOT NULL,
      cwd               TEXT,
      model             TEXT,
      started_at        TEXT    NOT NULL,
      ended_at          TEXT,
      last_event_at     TEXT    NOT NULL,
      bytes_generation  INTEGER NOT NULL DEFAULT 0,
      has_bytes         INTEGER NOT NULL DEFAULT 0,
      cloud_updated_at  INTEGER NOT NULL,
      fetched_at        INTEGER NOT NULL,
      jsonl_local_path  TEXT,
      PRIMARY KEY (owner_id, session_id)
    )
  `);
  // Additive: active_device_id added in PR 2.x (active-writer tracking).
  // Idempotent ALTER for installs that already have remote_sessions.
  try {
    db.exec(`ALTER TABLE remote_sessions ADD COLUMN active_device_id TEXT`);
  } catch { /* already exists */ }
  // Additive: device_label added for the cross-device session chip (PR 3.1).
  // Human-readable name pulled from each device's device_identity.label
  // (hostname() at install). Null on rows pushed before this column existed —
  // UI falls back to "Other device" then.
  try {
    db.exec(`ALTER TABLE remote_sessions ADD COLUMN device_label TEXT`);
  } catch { /* already exists */ }
  // Additive: total_bytes (PR 3.2a) — denormalised sum of chunk byte_count
  // across the current generation. Drives the empty-session filter on Home
  // so cross-device "ghost" sessions (title NULL, ended_at NULL, only a
  // handful of system events) stop crowding the list. NULL on rows pulled
  // before this column existed — those rows stay visible until the next
  // pull, then populate.
  try {
    db.exec(`ALTER TABLE remote_sessions ADD COLUMN total_bytes INTEGER`);
  } catch { /* already exists */ }

  // Tiny key→value table for one-shot migrations and feature flags. The
  // existing INSERT-OR-IGNORE-on-device_identity pattern only fires once
  // per install (first boot ever); for migrations gated on a specific
  // version of Oyster being installed, we need a separate flag. Each
  // flag's existence in this table means "this one-shot has already run."
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS remote_sessions_owner_last_event
             ON remote_sessions(owner_id, last_event_at DESC)`);

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
      last_event_at TEXT NOT NULL DEFAULT (datetime('now')),
      -- Persisted JSONL byte offset. Boot scan reads from last_offset to
      -- EOF and inserts events; live appends update it on every consume.
      -- Without this, sessions that finished before the watcher started
      -- (or before a restart) seeded the tracker at EOF and silently lost
      -- their transcript.
      last_offset   INTEGER NOT NULL DEFAULT 0
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

  // last_offset added in 0.5.0 to backfill transcripts on boot scan (#275).
  // Existing installs created sessions without this column; ALTER adds it.
  // last_offset specifically is also baked into _sessions_new in the
  // state-rename rebuild below, so this ALTER and the rebuild can run in
  // either order. source_id / cwd ALTERs (which post-date the rebuild)
  // run *after* the rebuild block so the rebuild can't drop them.
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN last_offset INTEGER NOT NULL DEFAULT 0");
  } catch { /* already exists */ }

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
      -- last_offset is set to 0 here; it only matters for installs that
      -- pre-date the running/awaiting rename, and those rebuilds always
      -- ran before #275 anyway (so the source rows have no last_offset).
      -- The boot scan re-derives offsets from disk on first run.
      CREATE TABLE _sessions_new (
        id            TEXT PRIMARY KEY,
        space_id      TEXT REFERENCES spaces(id) ON DELETE SET NULL,
        agent         TEXT NOT NULL CHECK (agent IN ('claude-code','opencode','codex')),
        title         TEXT,
        state         TEXT NOT NULL CHECK (state IN ('active','waiting','disconnected','done')),
        started_at    TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at      TEXT,
        model         TEXT,
        last_event_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_offset   INTEGER NOT NULL DEFAULT 0
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

  // source_id added so sessions can be grouped by project (sub-folder
  // within a space), not just by space. Lets us render an "Active
  // projects" section on Home without needing a separate join table.
  // ON DELETE SET NULL: detaching a source shouldn't blow up a
  // session record — it just unlinks the project association.
  // Lives *after* the state-rename rebuild so the rebuild (which
  // recreates the sessions table from scratch) can't drop it on
  // installs that trigger needsMigrate.
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN cwd TEXT");
  } catch { /* already exists */ }

  // assignment_mode: who owns the (space_id, source_id) classification on a
  // session row. `'auto'` means the longest-prefix heuristic may assign or
  // improve the binding as sources are attached / paths updated. `'manual'`
  // means the user (or an MCP-driven agent) has pinned the classification —
  // heuristics never overwrite it. Existing rows backfill to `'auto'`.
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN assignment_mode TEXT NOT NULL DEFAULT 'auto' CHECK (assignment_mode IN ('auto','manual'))");
  } catch { /* already exists */ }
  db.exec("CREATE INDEX IF NOT EXISTS sessions_auto_cwd ON sessions(cwd) WHERE assignment_mode = 'auto'");

  // ─────────────────────────────────────────────────────────────────────────
  // projects + project_paths — the simplified identity model that supersedes
  // `sources`. A project's id is its `.oyster/id` UUID (or a fresh UUID for
  // pre-existing sources without one). Sessions bind to projects directly via
  // `sessions.project_id`; the watcher tags them at ingest by reading
  // `<cwd>/.oyster/id`. No longest-prefix path matching, no async rebind, no
  // "Update folder location" — folder renames are filesystem ops that don't
  // touch Oyster's identity layer.
  //
  // `project_paths` is a per-machine cache of "where this project lives on
  // disk right now" — populated lazily by the watcher and used for affordances
  // like "Reveal in Finder". Worktrees and sibling checkouts share a project
  // id and contribute multiple rows. Authoritative identity is `projects.id`,
  // never the path.
  // ─────────────────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      space_id    TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      removed_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS projects_space_id ON projects(space_id) WHERE removed_at IS NULL;

    CREATE TABLE IF NOT EXISTS project_paths (
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path          TEXT NOT NULL,
      last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, path)
    );
    CREATE INDEX IF NOT EXISTS project_paths_path ON project_paths(path);
  `);

  try { db.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL"); }
  catch { /* already exists */ }
  db.exec("CREATE INDEX IF NOT EXISTS sessions_project_id ON sessions(project_id) WHERE project_id IS NOT NULL");

  try { db.exec("ALTER TABLE artifacts ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL"); }
  catch { /* already exists */ }
  db.exec("CREATE INDEX IF NOT EXISTS artifacts_project_id ON artifacts(project_id) WHERE project_id IS NOT NULL");

  // Sources → projects backfill was a one-shot for pre-rewrite installs;
  // it has already run on the only DB it ever needed to migrate. Fresh
  // installs go straight to the projects model.

  // ─────────────────────────────────────────────────────────────────────────
  // Drop the legacy sources surface. Order matters: SQLite refuses
  // ALTER TABLE DROP COLUMN while an index references the column, so
  // indexes go FIRST. Each step is idempotent — try/catch the ALTERs so
  // already-dropped state on fresh installs is a no-op, and IF EXISTS
  // on the DROP INDEX / TABLE handles both states.
  // ─────────────────────────────────────────────────────────────────────────
  db.exec("DROP INDEX IF EXISTS sessions_source_id");
  try { db.exec("ALTER TABLE sessions DROP COLUMN source_id"); } catch { /* already dropped or never existed */ }
  try { db.exec("ALTER TABLE artifacts DROP COLUMN source_id"); } catch { /* already dropped or never existed */ }
  db.exec("DROP TABLE IF EXISTS sources");

  // ─────────────────────────────────────────────────────────────────────────
  // Repair: heal sessions / artefacts whose space_id is out of sync with
  // their project's space. Source of the drift: an earlier ad-hoc dedup
  // SQL with a UPDATE-FROM order bug left some rows with a valid
  // project_id but space_id NULL — those then render as orphans in the
  // home view even though they belong to a real project. Idempotent: only
  // touches rows whose project is live AND whose space_id disagrees.
  // ─────────────────────────────────────────────────────────────────────────
  db.exec(`
    UPDATE sessions
       SET space_id = (
         SELECT p.space_id FROM projects p
          WHERE p.id = sessions.project_id AND p.removed_at IS NULL
       )
     WHERE project_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM projects p
          WHERE p.id = sessions.project_id
            AND p.removed_at IS NULL
            AND (sessions.space_id IS NULL OR sessions.space_id != p.space_id)
       );
  `);
  db.exec(`
    UPDATE artifacts
       SET space_id = (
         SELECT p.space_id FROM projects p
          WHERE p.id = artifacts.project_id AND p.removed_at IS NULL
       )
     WHERE project_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM projects p
          WHERE p.id = artifacts.project_id
            AND p.removed_at IS NULL
            AND (artifacts.space_id IS NULL OR artifacts.space_id != p.space_id)
       );
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // Tombstone recovery: artefacts the OLD self-heal tombstoned because
  // their folder happened to be renamed. For each soft-deleted row, try
  // the resolver — if the file is reachable under another cached path of
  // the same project, undelete + update path + stamp project_id. Truly
  // missing files stay tombstoned. JS-side because it needs filesystem
  // checks; safe to run on every boot — recovered rows are no longer
  // selected on subsequent passes (`removed_at IS NOT NULL` filter).
  // ─────────────────────────────────────────────────────────────────────────
  const tombstones = db
    .prepare("SELECT id, storage_config FROM artifacts WHERE removed_at IS NOT NULL AND storage_kind = 'filesystem'")
    .all() as Array<{ id: string; storage_config: string }>;
  if (tombstones.length > 0) {
    const update = db.prepare(
      "UPDATE artifacts SET removed_at = NULL, storage_config = ?, project_id = ?, updated_at = datetime('now') WHERE id = ?",
    );
    for (const row of tombstones) {
      let oldPath: string | undefined;
      try { oldPath = (JSON.parse(row.storage_config) as { path?: string }).path; } catch { /* malformed config, skip */ }
      if (!oldPath) continue;
      if (existsSync(oldPath)) {
        // File came back at the same path — undelete in place; stamp
        // project_id from the ancestor walk.
        const projectId = findProjectAtAncestor(db, oldPath);
        update.run(row.storage_config, projectId, row.id);
        continue;
      }
      const recovered = resolveArtifactPathViaProjects(db, oldPath);
      if (recovered) {
        update.run(JSON.stringify({ path: recovered.newPath }), recovered.projectId, row.id);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Artefact dedup: after recovery, multiple LIVE rows can point at the
  // same storage_config.path (e.g. one already-recovered + one survivor
  // at the same target). Collapse — keep the row with the most
  // session_artifacts touches (tiebreaker: most recent created_at).
  // Loser's links migrate to winner (with (session_id, role) dedup so we
  // don't multiply duplicate touches), losers soft-deleted.
  // Idempotent — after the collapse, exactly one live row per path.
  // ─────────────────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS artefact_dedup_winners AS
    WITH ranked AS (
      SELECT
        a.id,
        json_extract(a.storage_config, '$.path') AS path,
        ROW_NUMBER() OVER (
          PARTITION BY json_extract(a.storage_config, '$.path')
          ORDER BY
            (SELECT COUNT(*) FROM session_artifacts sa WHERE sa.artifact_id = a.id) DESC,
            a.created_at DESC
        ) AS rn
      FROM artifacts a
      WHERE a.removed_at IS NULL
        AND a.storage_kind = 'filesystem'
        AND json_extract(a.storage_config, '$.path') IS NOT NULL
    )
    SELECT loser.id AS loser_id, winner.id AS winner_id
      FROM ranked loser
      JOIN ranked winner ON winner.path = loser.path AND winner.rn = 1
     WHERE loser.rn > 1;
  `);
  // Drop loser-side links that would duplicate a (session_id, role) the
  // winner already owns — session_artifacts has a surrogate id PK so
  // naive UPDATE would otherwise multiply the same touch.
  db.exec(`
    DELETE FROM session_artifacts
     WHERE artifact_id IN (SELECT loser_id FROM artefact_dedup_winners)
       AND EXISTS (
         SELECT 1
           FROM session_artifacts sa
           JOIN artefact_dedup_winners m ON m.winner_id = sa.artifact_id
          WHERE sa.session_id = session_artifacts.session_id
            AND sa.role = session_artifacts.role
            AND m.loser_id = session_artifacts.artifact_id
       );
    UPDATE session_artifacts
       SET artifact_id = (SELECT winner_id FROM artefact_dedup_winners WHERE loser_id = session_artifacts.artifact_id)
     WHERE artifact_id IN (SELECT loser_id FROM artefact_dedup_winners);
    UPDATE artifacts SET removed_at = datetime('now')
     WHERE id IN (SELECT loser_id FROM artefact_dedup_winners);
    DROP TABLE artefact_dedup_winners;
  `);

  // One-time canonical-form migration for paths and cwds. The longest-prefix
  // binding SQL compares `sessions.cwd` against `sources.path` via substr
  // equality, which requires identical separator conventions and no trailing
  // slash. New writes go through `normaliseSourcePath` (which produces
  // forward-slash, trimmed strings); pre-existing rows may have backslashes
  // (Windows) or trailing slashes. Rewrite them in place once so the new
  // heuristic catches everything that ought to match. Idempotent: re-running
  // on already-canonical rows is a no-op. We do NOT resolve symlinks here
  // (that would require a JS-side loop with realpath calls per row and
  // wouldn't work for missing paths) — separator + trim is enough to fix
  // the cross-platform case that motivated this.
  //
  // Drive-root guard: a path of `C:\` after the `\` → `/` replace becomes
  // `C:/`. A naive `rtrim(..., '/')` would strip that final slash and leave
  // `C:`, which is an invalid path. The CASE preserves the slash when the
  // result looks like a drive root.
  const canonicalisePath = `CASE
    WHEN replace($col, '\\', '/') = '/' THEN '/'
    WHEN length(replace($col, '\\', '/')) = 3
         AND substr(replace($col, '\\', '/'), 2, 2) = ':/'
      THEN replace($col, '\\', '/')
    ELSE rtrim(replace($col, '\\', '/'), '/')
  END`;
  db.exec(`
    UPDATE sessions
       SET cwd = ${canonicalisePath.replace(/\$col/g, "cwd")}
     WHERE cwd IS NOT NULL
       AND (cwd LIKE '%\\%'
            OR (length(cwd) > 1
                AND substr(cwd, length(cwd), 1) = '/'
                AND NOT (length(cwd) = 3 AND substr(cwd, 2, 2) = ':/')));
  `);

  // Cloud session sync (#322). Seven columns drive the cross-device sync:
  // - sync_dirty_at: unix-ms of the most recent material change since last
  //   successful push. NULL = clean. Overwritten on every dirty mark, so
  //   bursty updates collapse to the latest. Mirrors spaces.sync_dirty_at.
  // - cloud_synced_at: unix-ms of the last successful push acknowledgement.
  //   The dirty predicate is `sync_dirty_at IS NOT NULL AND
  //   (cloud_synced_at IS NULL OR cloud_synced_at < sync_dirty_at)`, so a
  //   dirty bump after a successful push correctly re-pends the row.
  // - cloud_owner_id: which Pro account owns this session. The push gate
  //   only sends events whose cloud_owner_id matches the current Pro user
  //   (account-switching protection, mirrors the memory-events column).
  // - jsonl_synced_at: unix-ms of last successful chunked-bytes push.
  // - jsonl_snapshot_offset: plaintext-byte offset already uploaded for this
  //   session in the current bytes_generation. Snapshot timer skips a
  //   session whose disk file hasn't grown past this. Reset to 0 on
  //   truncation (which also bumps bytes_generation).
  // - jsonl_chunk_count: number of chunks uploaded in the current generation.
  //   Next PUT goes as chunk (jsonl_chunk_count + 1).
  // - bytes_generation: monotonic per-session counter. Bumped when the local
  //   jsonl is truncated (rare). Stale in-flight chunks from earlier
  //   generations are rejected by the worker.
  for (const sql of [
    "ALTER TABLE sessions ADD COLUMN sync_dirty_at INTEGER",
    "ALTER TABLE sessions ADD COLUMN cloud_synced_at INTEGER",
    "ALTER TABLE sessions ADD COLUMN cloud_owner_id TEXT",
    "ALTER TABLE sessions ADD COLUMN jsonl_synced_at INTEGER",
    "ALTER TABLE sessions ADD COLUMN jsonl_snapshot_offset INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sessions ADD COLUMN jsonl_chunk_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sessions ADD COLUMN bytes_generation INTEGER NOT NULL DEFAULT 0",
    // Absolute on-disk path to the session's jsonl file. The watcher knows
    // this directly (it's the chokidar event path); pushBytes used to
    // recompute it as `projectsRoot()/encodeCwd(cwd)/<id>.jsonl`, which
    // breaks for cross-device resumed sessions where the events still carry
    // the origin device's cwd (e.g. "C:\\Users\\matth" on a Mac-resumed
    // Windows session). Storing the real path is the only ground truth.
    "ALTER TABLE sessions ADD COLUMN jsonl_path TEXT",
    // Terminal UX: in-memory PTY identity. terminal_id is the UUID of the
    // live PTY (null between boots); terminal_attached_clients is the count
    // of WebSocket connections currently tailing the output. Both are reset
    // to null/0 on boot (see boot reset below) because PTYs are in-memory
    // only and don't survive a server restart.
    "ALTER TABLE sessions ADD COLUMN terminal_id TEXT",
    "ALTER TABLE sessions ADD COLUMN terminal_attached_clients INTEGER NOT NULL DEFAULT 0",
  ]) {
    try { db.exec(sql); } catch { /* already exists */ }
  }
  // Index the dirty predicate so the outbox scan stays cheap as the
  // sessions table grows. Mirror of spaces.sync_dirty_at pattern.
  db.exec(
    `CREATE INDEX IF NOT EXISTS sessions_sync_dirty
       ON sessions(sync_dirty_at) WHERE sync_dirty_at IS NOT NULL`,
  );

  // Classify slash-command machinery (`<command-…>`, `<local-command-…>`,
  // `<system-reminder>`) at ingest so the transcript reader and the FTS
  // search index can both ignore it while the raw row stays on disk for
  // audit. See #530 + server/src/utils/claude-protocol-artifacts.ts.
  try {
    db.exec("ALTER TABLE session_events ADD COLUMN is_protocol_artifact INTEGER NOT NULL DEFAULT 0");
  } catch { /* already exists */ }

  // ── R2 verbatim recall (#311): FTS5 over session_events.text ──
  // Lives after the state-rename rebuild block (which DROPs and rebuilds
  // session_events) so the virtual table + triggers always end up
  // attached to the final concrete table. We index `text` only — `raw`
  // is the original JSONL with metadata + JSON syntax, which would
  // bloat the index and pollute matches.
  //
  // Triggers are gated on `is_protocol_artifact`:
  //   - AI re-indexes only non-artifact rows.
  //   - AD / AU's delete-half only fires when the row WAS indexed
  //     (old.is_protocol_artifact = 0); FTS5 'delete' is unsafe to call
  //     for a rowid that isn't in the inverted index (#530).
  // Drop-then-create keeps existing installs in sync after the trigger
  // shape changed in this migration.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_events_fts USING fts5(
      text,
      content=session_events,
      content_rowid=id
    );

    DROP TRIGGER IF EXISTS session_events_ai;
    DROP TRIGGER IF EXISTS session_events_ad;
    DROP TRIGGER IF EXISTS session_events_au;
    DROP TRIGGER IF EXISTS session_events_au_del;
    DROP TRIGGER IF EXISTS session_events_au_ins;

    CREATE TRIGGER session_events_ai AFTER INSERT ON session_events
    WHEN new.is_protocol_artifact = 0 BEGIN
      INSERT INTO session_events_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER session_events_ad AFTER DELETE ON session_events
    WHEN old.is_protocol_artifact = 0 BEGIN
      INSERT INTO session_events_fts(session_events_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;
    CREATE TRIGGER session_events_au_del AFTER UPDATE ON session_events
    WHEN old.is_protocol_artifact = 0 BEGIN
      INSERT INTO session_events_fts(session_events_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;
    CREATE TRIGGER session_events_au_ins AFTER UPDATE ON session_events
    WHEN new.is_protocol_artifact = 0 BEGIN
      INSERT INTO session_events_fts(rowid, text) VALUES (new.id, new.text);
    END;
  `);

  // One-time backfill: mark existing protocol-artifact rows on installs
  // that pre-date this migration. The UPDATE fires session_events_au_del
  // for each (old artifact=0 → indexed in FTS), pulling those rows out of
  // the inverted index; session_events_au_ins skips the re-insert because
  // new.is_protocol_artifact = 1.
  //
  // Gated via app_state so the full-table predicate scan doesn't run on
  // every boot — session_events grows roughly linearly with usage and
  // there's no useful index for the leading-whitespace + prefix check.
  //
  // Predicate mirrors isClaudeProtocolArtifact: strip leading whitespace
  // (space/tab/LF/CR) and check the three wrapper prefixes. Only USER
  // events qualify — assistant slash-command echoes (e.g. `/rename …`)
  // stay visible.
  {
    const flag = db.prepare(
      `INSERT OR IGNORE INTO app_state (key, value, applied_at)
       VALUES ('protocol_artifact_backfill_done', '1', ?)`,
    ).run(Date.now());
    if (flag.changes > 0) {
      db.exec(`
        UPDATE session_events
           SET is_protocol_artifact = 1
         WHERE is_protocol_artifact = 0
           AND role = 'user'
           AND (
             ltrim(text, ' ' || char(9) || char(10) || char(13)) LIKE '<local-command-%'
             OR ltrim(text, ' ' || char(9) || char(10) || char(13)) LIKE '<command-%'
             OR ltrim(text, ' ' || char(9) || char(10) || char(13)) LIKE '<system-reminder>%'
           );
      `);
    }
  }

  // v2 backfill (#536) lives in runDeferredMigrations() — it scans
  // session_events and fires FTS-delete triggers per matched row, which
  // takes tens of seconds on a multi-million-row table. Boot can't wait
  // for that; the cleanup runs after the listening socket is up.

  // FTS health is no longer audited here. The previous heuristic (full
  // COUNT scan + 'a'-token frequency sample) took 17 s+ on a 1.3M-row
  // session_events table AND false-positived on transcripts dominated by
  // short tool markers ("[Bash]", "[Edit]"). It made boot hostage to the
  // size of the search index. Repair now happens out-of-band — see
  // repairFtsIfUnhealthy() below, invoked after the server is listening.

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

  // Stale-indicator reset. PTYs live in-memory only — they don't survive a
  // server restart, so any non-null terminal_id or non-zero attached count
  // from the previous boot is meaningless.
  db.prepare(
    `UPDATE sessions
       SET terminal_id = NULL, terminal_attached_clients = 0
     WHERE terminal_id IS NOT NULL OR terminal_attached_clients > 0`,
  ).run();

  console.log(`[db] migrations applied in ${Math.round(performance.now() - initT0)}ms`);
  return db;
}

/**
 * One-shot migrations that touch large tables and so can't run during
 * boot. Each is gated by an `app_state` flag so it runs exactly once
 * per userland. Search results may be slightly off (e.g. transcript rows
 * that should be hidden still appearing) for the duration of the first
 * post-upgrade boot.
 */
export function runDeferredMigrations(db: Database.Database): void {
  // v2 protocol-artefact backfill (#536). The original v1 backfill only
  // caught role='user' rows wrapped in <local-command-…>; v2 also catches
  // role='system' rows with the `local_command:` prefix. Each matched
  // row's UPDATE fires session_events_au_del, removing it from the FTS
  // inverted index — that's where the time goes on large tables.
  const existing = db.prepare(
    "SELECT 1 FROM app_state WHERE key = 'protocol_artifact_backfill_v2_done'",
  ).get();
  if (existing) return;

  console.log("[db] running deferred backfill: protocol_artifact_backfill_v2");
  const t0 = performance.now();
  // UPDATE + flag-write commit together — otherwise an interrupt between
  // them leaves the DB half-migrated and the gate set, so we never retry.
  const applied = db.transaction(() => {
    const result = db.prepare(`
      UPDATE session_events
         SET is_protocol_artifact = 1
       WHERE is_protocol_artifact = 0
         AND role = 'system'
         AND ltrim(text, ' ' || char(9) || char(10) || char(13)) LIKE 'local_command:%'
    `).run();
    db.prepare(
      `INSERT OR IGNORE INTO app_state (key, value, applied_at)
       VALUES ('protocol_artifact_backfill_v2_done', '1', ?)`,
    ).run(Date.now());
    return result;
  })();
  console.log(`[db] protocol_artifact_backfill_v2 complete: marked ${applied.changes} rows in ${Math.round(performance.now() - t0)}ms`);
}

/**
 * Out-of-band FTS health check + repair. Invoked after the HTTP server is
 * listening so a multi-GB transcript index can never block boot. Strategy:
 * sample the 50 most-recent indexable session_events rows and look each one
 * up by rowid in session_events_fts. If most are missing, the index is
 * genuinely broken (typical cause: dev hot-reload that left INSERT triggers
 * half-applied) and we rebuild. Otherwise we leave it alone.
 *
 * Replaces an earlier heuristic that counted FTS hits for the token 'a'
 * and compared against the total indexable row count. Both queries were
 * full-table scans on session_events (no covering index), and the 'a'
 * threshold false-positived on transcripts dominated by short tool markers
 * like "[Bash]" / "[Edit]" — triggering a synchronous multi-second rebuild
 * on every boot of a healthy index.
 */
export function repairFtsIfUnhealthy(db: Database.Database): void {
  const t0 = performance.now();
  const recent = db.prepare(
    `SELECT id FROM session_events
      WHERE is_protocol_artifact = 0
      ORDER BY id DESC
      LIMIT 50`,
  ).all() as Array<{ id: number }>;
  if (recent.length === 0) return;

  const lookup = db.prepare("SELECT 1 AS x FROM session_events_fts WHERE rowid = ?");
  let missing = 0;
  for (const row of recent) {
    if (!lookup.get(row.id)) missing++;
  }

  // Rebuild only when most of the recent tail is missing — that's the
  // hot-reload-corruption signature the original check was guarding against.
  // A handful of misses can happen transiently and don't justify rebuilding
  // a multi-GB index.
  if (missing * 2 <= recent.length) {
    console.log(`[fts] healthy: ${recent.length - missing}/${recent.length} recent rows indexed (${Math.round(performance.now() - t0)}ms)`);
    return;
  }

  console.warn(`[fts] ${missing}/${recent.length} recent rows missing from search index — rebuilding (search may be degraded until this completes)`);
  const rebuildT0 = performance.now();
  // 'rebuild' re-indexes from the content table; protocol-artefact rows
  // bypass the gated triggers during rebuild, so we sweep them back out
  // explicitly afterwards. Rebuild + sweep commit together — otherwise an
  // interrupt between them leaves artefact rows in the index that the
  // gated triggers won't clean up later, and the next boot's health check
  // may pass and never re-clean.
  db.transaction(() => {
    db.exec(`
      INSERT INTO session_events_fts(session_events_fts) VALUES('rebuild');
      INSERT INTO session_events_fts(session_events_fts, rowid, text)
        SELECT 'delete', id, text
          FROM session_events
         WHERE is_protocol_artifact = 1;
    `);
  })();
  console.log(`[fts] rebuild complete in ${Math.round(performance.now() - rebuildT0)}ms`);
}
