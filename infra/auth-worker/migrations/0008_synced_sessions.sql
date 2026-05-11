-- 0008_synced_sessions.sql — cross-device session sync substrate (#322).
-- Spec: PR #431 (eventual-soaring-swan plan).
--
-- Per-row LWW model. Sessions are append-only by nature (one device produces
-- a session, another resumes it as a fresh session) so we don't need an event
-- log here — just the latest metadata row per session, and the R2 key once
-- the bytes are uploaded. Pro-only writes; gate enforced on the Worker.

CREATE TABLE IF NOT EXISTS synced_session_metadata (
  owner_id        TEXT    NOT NULL,
  session_id      TEXT    NOT NULL,
  device_id       TEXT,                 -- which device pushed this row
  agent           TEXT    NOT NULL,
  title           TEXT,
  state           TEXT    NOT NULL,
  cwd             TEXT,
  model           TEXT,
  started_at      TEXT    NOT NULL,
  ended_at        TEXT,
  last_event_at   TEXT    NOT NULL,
  jsonl_r2_key    TEXT,                 -- NULL until bytes uploaded
  updated_at      INTEGER NOT NULL,     -- LWW tiebreaker; unix ms
  PRIMARY KEY (owner_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_synced_session_metadata_owner_updated
  ON synced_session_metadata (owner_id, updated_at DESC);

-- The list endpoint orders by last_event_at DESC (user-facing ""most recently
-- active first""), distinct from updated_at (the LWW sync tiebreaker). Without
-- this index a Pro user with hundreds of sessions would force a sort per GET.
CREATE INDEX IF NOT EXISTS idx_synced_session_metadata_owner_last_event
  ON synced_session_metadata (owner_id, last_event_at DESC);
