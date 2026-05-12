-- 0010_device_label.sql — human-readable origin device label for cross-device UI (#322).
--
-- We've had `device_id` (an opaque UUID) since 0008 and `active_device_id`
-- since 0009. Neither is readable. The cross-device session card in the UI
-- needs something like "↗ MacBookPro" — that comes from this column.
--
-- Sourced from each device's local `device_identity.label` (hostname() at
-- install time today; user-renameable in a future release). Backfill is
-- left NULL: old metadata rows pre-date label sync, the UI falls back to
-- "Other device" until those sessions get re-pushed by their origin.

ALTER TABLE synced_session_metadata
  ADD COLUMN device_label TEXT;
