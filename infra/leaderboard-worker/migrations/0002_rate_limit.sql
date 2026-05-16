-- Per-key rate-limit table. Worker writes the hashed IP + last_at on every
-- POST and rejects if the previous submission was within the cooldown window.
CREATE TABLE IF NOT EXISTS rate_limit (
  key      TEXT PRIMARY KEY,
  last_at  INTEGER NOT NULL
);
