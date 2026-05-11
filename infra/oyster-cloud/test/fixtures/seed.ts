// Minimal test fixtures for oyster-cloud bootstrap tests.
// Each test file gets an isolated in-memory D1 binding via @cloudflare/vitest-pool-workers.

import { env } from "cloudflare:test";

const SCHEMA_SQL = `
-- Mirror of oyster-auth's relevant schema for tests. Keep in sync with:
--   infra/auth-worker/migrations/0001_init.sql  (users, sessions)
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  tier          TEXT NOT NULL DEFAULT 'free'
);
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);
-- Mirror of infra/auth-worker/migrations/0007_synced_memories.sql
CREATE TABLE IF NOT EXISTS synced_memory_events (
  owner_id        TEXT    NOT NULL,
  event_id        TEXT    NOT NULL,
  memory_id       TEXT    NOT NULL,
  event_type      TEXT    NOT NULL CHECK (event_type IN ('memory_created','memory_forgotten','memory_purged')),
  space_id        TEXT,
  created_at      INTEGER NOT NULL,
  ingested_at     INTEGER NOT NULL,
  PRIMARY KEY (owner_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_synced_memory_events_owner_created
  ON synced_memory_events (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_synced_memory_events_memory
  ON synced_memory_events (owner_id, memory_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_synced_memory_created
  ON synced_memory_events (owner_id, memory_id) WHERE event_type = 'memory_created';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_synced_memory_forgotten
  ON synced_memory_events (owner_id, memory_id) WHERE event_type = 'memory_forgotten';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_synced_memory_purged
  ON synced_memory_events (owner_id, memory_id) WHERE event_type = 'memory_purged';
CREATE TABLE IF NOT EXISTS synced_memory_payloads (
  owner_id   TEXT NOT NULL,
  memory_id  TEXT NOT NULL,
  content    TEXT,
  tags       TEXT NOT NULL DEFAULT '[]',
  purged_at  INTEGER,
  PRIMARY KEY (owner_id, memory_id)
);
-- Mirror of infra/auth-worker/migrations/0008_synced_sessions.sql
CREATE TABLE IF NOT EXISTS synced_session_metadata (
  owner_id        TEXT    NOT NULL,
  session_id      TEXT    NOT NULL,
  device_id       TEXT,
  agent           TEXT    NOT NULL,
  title           TEXT,
  state           TEXT    NOT NULL,
  cwd             TEXT,
  model           TEXT,
  started_at      TEXT    NOT NULL,
  ended_at        TEXT,
  last_event_at   TEXT    NOT NULL,
  jsonl_r2_key    TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (owner_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_synced_session_metadata_owner_updated
  ON synced_session_metadata (owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_synced_session_metadata_owner_last_event
  ON synced_session_metadata (owner_id, last_event_at DESC);
`;

export async function applySchema(): Promise<void> {
  const stmts = SCHEMA_SQL.split(";").map(s => s.trim()).filter(Boolean);
  for (const s of stmts) {
    await env.DB.prepare(s).run();
  }
}
