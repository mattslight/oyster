CREATE TABLE waitlist (
  email      TEXT PRIMARY KEY,
  joined_at  INTEGER NOT NULL,
  source     TEXT,
  ip_country TEXT,
  user_agent TEXT
);

CREATE INDEX idx_waitlist_joined ON waitlist (joined_at);
