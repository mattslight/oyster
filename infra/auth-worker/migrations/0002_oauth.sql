-- Oyster auth — OAuth schema delta (see docs/plans/auth-oauth.md).
-- Two new tables, both additive. Existing tables (users, sessions,
-- device_codes, magic_link_tokens) are unchanged.

CREATE TABLE IF NOT EXISTS user_identities (
  provider           TEXT NOT NULL,                  -- 'github' (later: 'google')
  provider_user_id   TEXT NOT NULL,                  -- GitHub's stable numeric id, as text
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_email     TEXT,                           -- informational; current verified primary at last sign-in
  linked_at          INTEGER NOT NULL,               -- unix ms
  last_seen_at       INTEGER NOT NULL,               -- unix ms; bumped per sign-in
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS user_identities_user ON user_identities(user_id);

CREATE TABLE IF NOT EXISTS oauth_states (
  state              TEXT PRIMARY KEY,               -- 32-byte base64url, single-use CSRF token
  provider           TEXT NOT NULL,
  pkce_verifier      TEXT NOT NULL,                  -- 43-char base64url, S256-only
  user_code          TEXT,                           -- nullable; ties this flow to a local-sign-in handoff
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,               -- 5 min from created_at
  consumed_at        INTEGER                         -- set on /callback; replay defence
);
