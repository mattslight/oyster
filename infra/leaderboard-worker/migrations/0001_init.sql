CREATE TABLE IF NOT EXISTS scores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  initials    TEXT NOT NULL,
  score       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  ip_country  TEXT,
  user_agent  TEXT
);

-- Ranking index: score DESC, created_at ASC (oldest wins on ties).
CREATE INDEX IF NOT EXISTS idx_scores_rank ON scores (score DESC, created_at ASC);
