-- Multi-game arcade: each row is scoped to a game key. Existing rocket-ship
-- scores get the back-compat default so reads of the rocket-ship board are
-- unchanged. The ranking index is recreated to include `game` as its leading
-- column so per-game queries hit the index instead of scanning the table.
ALTER TABLE scores ADD COLUMN game TEXT NOT NULL DEFAULT 'rocket-ship';
DROP INDEX IF EXISTS idx_scores_rank;
CREATE INDEX idx_scores_rank ON scores (game, score DESC, created_at ASC);
