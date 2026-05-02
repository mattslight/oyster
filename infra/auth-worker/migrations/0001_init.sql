-- Oyster auth — D1 schema (see docs/plans/auth.md for the full design).
-- Four tables: users, sessions, device_codes, magic_link_tokens.
-- Ordered so every FK refers to a table that already exists at the
-- point of CREATE — SQLite tolerates forward references, but explicit
-- ordering is less surprising and survives migration replays.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,                  -- ulid
  email         TEXT NOT NULL UNIQUE,              -- lowercased on insert
  created_at    INTEGER NOT NULL,                  -- unix ms
  last_seen_at  INTEGER NOT NULL                   -- unix ms; bump on session activity
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,                  -- ulid; opaque session token (cookie value + device-flow result)
  user_id       TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,                  -- unix ms; 30 days, sliding
  revoked_at    INTEGER                            -- unix ms; set on sign-out
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Device-flow handoff. RFC 8628 shape:
--   `device_code` is the long opaque token the local server polls with.
--   `user_code` is the short readable token that travels through the
--    browser URL (oyster.to/sign-in?d=<user_code>).
-- Storing both keeps the lookup direction unambiguous: browser submits
-- user_code → Worker resolves to device_code row → magic-link verify
-- writes session_id → local poller reads by device_code.
CREATE TABLE IF NOT EXISTS device_codes (
  device_code   TEXT PRIMARY KEY,                  -- 32-char base64url; what the local server polls with
  user_code     TEXT NOT NULL UNIQUE,              -- 8-char base32 (e.g. BHRT-9KQ2); what the user sees
  session_id    TEXT REFERENCES sessions(id),      -- null until verify; set once
  expires_at    INTEGER NOT NULL,                  -- unix ms; +10 min on issue
  claimed_at    INTEGER                            -- unix ms; set when local poller picks up the token
);

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  token_hash    TEXT PRIMARY KEY,                  -- sha256(raw token); raw never stored
  user_id       TEXT NOT NULL REFERENCES users(id),
  device_code   TEXT REFERENCES device_codes(device_code),  -- null when login originated in a browser, set for device-flow logins
  expires_at    INTEGER NOT NULL,                  -- unix ms; +15 min on issue
  consumed_at   INTEGER                            -- unix ms; set on verify, single-use
);
CREATE INDEX IF NOT EXISTS magic_link_tokens_user_expires
  ON magic_link_tokens(user_id, expires_at);
