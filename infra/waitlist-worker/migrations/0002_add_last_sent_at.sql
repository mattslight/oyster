-- Track when we last sent a confirmation email so resubmissions can
-- legitimately re-trigger a confirmation after a cooldown (5 minutes).
-- Existing rows are seeded from joined_at, so rows older than the
-- cooldown are eligible for a fresh confirmation immediately, while
-- newer rows remain subject to the normal 5-minute cooldown.

ALTER TABLE waitlist ADD COLUMN last_sent_at INTEGER;
UPDATE waitlist SET last_sent_at = joined_at WHERE last_sent_at IS NULL;
