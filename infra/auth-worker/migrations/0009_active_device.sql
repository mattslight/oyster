-- 0009_active_device.sql — active-writer tracking for cross-device sessions (#322).
--
-- A session belongs to one "active writer" device at a time. When a device
-- resumes a session that another device was last working on, ownership
-- atomically transfers to the resuming device. This drives the
-- "Session is now active on Windows" UI signal and keeps the chunk chain
-- linear (no parallel branches).
--
-- Pattern A from the design discussion: one session_id, one timeline.
-- Forks only happen when a user explicitly chooses to keep divergent
-- local edits as a new session — that flow doesn't touch this column.

ALTER TABLE synced_session_metadata
  ADD COLUMN active_device_id TEXT;

-- Backfill: for sessions already in cloud at the time of this migration,
-- the most recent writer is the only writer we know about. Use device_id
-- (which 0008 already populates and 0.8.1-beta.3 backfilled). After this
-- migration, every subsequent chunk PUT bumps active_device_id to the
-- pushing device.
UPDATE synced_session_metadata
   SET active_device_id = device_id
 WHERE active_device_id IS NULL
   AND device_id IS NOT NULL;
