-- 0007_synced_memories.sql — cross-device memory sync substrate (#318).
-- Spec: docs/superpowers/specs/2026-05-08-memory-sync-design.md
--
-- Append-only event log + redactable payload store. Per-type uniqueness
-- enforces the spec's idempotent-replay invariants. Pro-only writes; gate
-- enforced on the Worker handler.

CREATE TABLE IF NOT EXISTS synced_memory_events (
  owner_id        TEXT    NOT NULL,
  event_id        TEXT    NOT NULL,
  memory_id       TEXT    NOT NULL,
  event_type      TEXT    NOT NULL CHECK (event_type IN ('memory_created','memory_forgotten','memory_purged')),
  space_id        TEXT,                -- meaningful only when event_type = 'memory_created'
  created_at      INTEGER NOT NULL,    -- unix ms; not used for LWW, just ordering
  ingested_at     INTEGER NOT NULL,    -- when the cloud accepted the event
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
  content    TEXT,                     -- NULL after purge
  tags       TEXT NOT NULL DEFAULT '[]',
  purged_at  INTEGER,                  -- non-NULL after purge
  PRIMARY KEY (owner_id, memory_id)
);
