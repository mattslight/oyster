-- 0006_synced_spaces.sql — cross-device mirror of the local spaces table.
-- Spec: docs/superpowers/specs/2026-05-06-spaces-sync-spinout-design.md
-- Wedge of #319 (R1). Used by the local server's space-sync-service to
-- reconcile per-user spaces across devices. Tombstones propagate deletes.
-- Lives in the shared oyster-auth D1 (oyster-publish Worker reads/writes it).

CREATE TABLE IF NOT EXISTS synced_spaces (
  owner_id        TEXT    NOT NULL,
  space_id        TEXT    NOT NULL,
  display_name    TEXT    NOT NULL,
  color           TEXT,
  parent_id       TEXT,
  summary_title   TEXT,
  summary_content TEXT,
  updated_at      INTEGER NOT NULL,    -- unix ms; LWW comparison key
  deleted_at      INTEGER,             -- tombstone; non-NULL means deleted
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (owner_id, space_id)
);

CREATE INDEX IF NOT EXISTS idx_synced_spaces_owner_updated
  ON synced_spaces (owner_id, updated_at DESC);
