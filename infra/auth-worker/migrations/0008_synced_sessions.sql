-- 0008_synced_sessions.sql — cross-device session sync substrate (#322).
-- Implementation: PR #431.
--
-- Two tables drive the cross-device sync:
--   1. synced_session_metadata — per-session metadata row, LWW on updated_at,
--      with bytes_generation incrementing on truncation/reset.
--   2. synced_session_chunks — append-only manifest of encrypted jsonl chunks
--      uploaded for the session. Manifest reads filter to current generation.
-- Pro-only writes; gate enforced on the Worker.

CREATE TABLE IF NOT EXISTS synced_session_metadata (
  owner_id          TEXT    NOT NULL,
  session_id        TEXT    NOT NULL,
  device_id         TEXT,                 -- which device pushed this row
  agent             TEXT    NOT NULL,
  title             TEXT,
  state             TEXT    NOT NULL,
  cwd               TEXT,
  model             TEXT,
  started_at        TEXT    NOT NULL,
  ended_at          TEXT,
  last_event_at     TEXT    NOT NULL,
  bytes_generation  INTEGER NOT NULL DEFAULT 0,  -- bumped on reset; chunks scoped to current gen
  updated_at        INTEGER NOT NULL,     -- LWW tiebreaker; unix ms
  PRIMARY KEY (owner_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_synced_session_metadata_owner_updated
  ON synced_session_metadata (owner_id, updated_at DESC);

-- The list endpoint orders by last_event_at DESC (user-facing "most recently
-- active first"), distinct from updated_at (the LWW sync tiebreaker). Without
-- this index a Pro user with hundreds of sessions would force a sort per GET.
CREATE INDEX IF NOT EXISTS idx_synced_session_metadata_owner_last_event
  ON synced_session_metadata (owner_id, last_event_at DESC);

-- Chunk manifest. Each row is one delta-uploaded encrypted jsonl segment.
-- PK includes bytes_generation so a reset (which bumps the generation on
-- the metadata row) cleanly orphans prior-generation rows without DELETE —
-- manifest reads filter to the current generation. Background GC of
-- orphaned R2 objects from older generations deferred to v1.1.
--
-- plaintext_sha256 is verified by Device B after per-chunk download to
-- detect bit-rot or transport error. byte_count is denormalised
-- (end_offset - start_offset) so manifest reads don't recompute.
CREATE TABLE IF NOT EXISTS synced_session_chunks (
  owner_id          TEXT    NOT NULL,
  session_id        TEXT    NOT NULL,
  bytes_generation  INTEGER NOT NULL,
  chunk_number      INTEGER NOT NULL,
  start_offset      INTEGER NOT NULL,    -- plaintext byte offset of first byte in this chunk
  end_offset        INTEGER NOT NULL,    -- plaintext byte offset just past last byte
  byte_count        INTEGER NOT NULL,    -- end_offset - start_offset
  plaintext_sha256  TEXT    NOT NULL,    -- hex digest of plaintext chunk bytes
  uploaded_at       INTEGER NOT NULL,
  PRIMARY KEY (owner_id, session_id, bytes_generation, chunk_number)
);

CREATE INDEX IF NOT EXISTS idx_synced_session_chunks_active
  ON synced_session_chunks (owner_id, session_id, bytes_generation, chunk_number);
