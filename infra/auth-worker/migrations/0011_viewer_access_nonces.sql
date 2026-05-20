-- 0011_viewer_access_nonces.sql — single-use access nonces for the viewer access redirect.
--
-- Used by /api/publish/access-redirect/<token> to mint a short-lived, opaque
-- handoff token that share.oyster.to consumes. The viewer worker enforces
-- single-use via an atomic UPDATE ... WHERE consumed_at IS NULL, with
-- share_token in the WHERE clause so a nonce minted for share A cannot be
-- burned against share B's URL. user_id is for audit only; it is never
-- surfaced in any response.
--
-- TTL is 60s (enforced in application code). Mint is opportunistic and
-- deletes expired rows on each insert, so the table stays small.

CREATE TABLE viewer_access_nonces (
  nonce        TEXT    PRIMARY KEY,
  share_token  TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_viewer_access_nonces_expires
  ON viewer_access_nonces(expires_at);
