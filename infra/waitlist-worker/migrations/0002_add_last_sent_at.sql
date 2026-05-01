-- Track when we last sent a confirmation email so resubmissions can
-- legitimately re-trigger a confirmation after a cooldown (5 minutes).
-- Existing rows seeded from joined_at so they're eligible for a fresh
-- confirmation immediately.

ALTER TABLE waitlist ADD COLUMN last_sent_at INTEGER;
UPDATE waitlist SET last_sent_at = joined_at WHERE last_sent_at IS NULL;
