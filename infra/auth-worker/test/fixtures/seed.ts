// Test fixtures for auth-worker integration tests.
// Each test file gets an isolated in-memory D1 binding via
// @cloudflare/vitest-pool-workers.

import { env } from "cloudflare:test";

// Full schema from all four migrations, collapsed for tests.
// Keep in sync with:
//   infra/auth-worker/migrations/0001_init.sql  (users, sessions, device_codes, magic_link_tokens)
//   infra/auth-worker/migrations/0002_oauth.sql (user_identities, oauth_states)
//   infra/auth-worker/migrations/0003_publish.sql (users.tier, published_artifacts)
//   infra/auth-worker/migrations/0004_return_path.sql (return_path columns)
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  tier          TEXT NOT NULL DEFAULT 'free'
);
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS device_codes (
  device_code   TEXT PRIMARY KEY,
  user_code     TEXT NOT NULL UNIQUE,
  session_id    TEXT REFERENCES sessions(id),
  expires_at    INTEGER NOT NULL,
  claimed_at    INTEGER
);
CREATE TABLE IF NOT EXISTS magic_link_tokens (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  device_code   TEXT REFERENCES device_codes(device_code),
  expires_at    INTEGER NOT NULL,
  consumed_at   INTEGER,
  return_path   TEXT
);
CREATE INDEX IF NOT EXISTS magic_link_tokens_user_expires
  ON magic_link_tokens(user_id, expires_at);
CREATE TABLE IF NOT EXISTS user_identities (
  provider           TEXT NOT NULL,
  provider_user_id   TEXT NOT NULL,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_email     TEXT,
  linked_at          INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS user_identities_user ON user_identities(user_id);
CREATE TABLE IF NOT EXISTS oauth_states (
  state              TEXT PRIMARY KEY,
  provider           TEXT NOT NULL,
  pkce_verifier      TEXT NOT NULL,
  user_code          TEXT,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  consumed_at        INTEGER,
  return_path        TEXT
);
CREATE TABLE IF NOT EXISTS published_artifacts (
  share_token       TEXT    PRIMARY KEY,
  owner_user_id     TEXT    NOT NULL REFERENCES users(id),
  artifact_id       TEXT    NOT NULL,
  artifact_kind     TEXT    NOT NULL,
  mode              TEXT    NOT NULL CHECK (mode IN ('open','password','signin')),
  password_hash     TEXT,
  r2_key            TEXT    NOT NULL,
  content_type      TEXT    NOT NULL,
  size_bytes        INTEGER NOT NULL,
  published_at      INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  unpublished_at    INTEGER,
  CHECK (
    (mode = 'password' AND password_hash IS NOT NULL) OR
    (mode <> 'password' AND password_hash IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_pubart_owner ON published_artifacts(owner_user_id);
`;

export async function applySchema(): Promise<void> {
  // D1 .exec runs multi-statement SQL but ignores comments inconsistently;
  // split on semicolons and run each non-empty statement.
  const stmts = SCHEMA_SQL.split(";").map(s => s.trim()).filter(Boolean);
  for (const s of stmts) {
    await env.DB.prepare(s).run();
  }
}

export async function seedUserCode(opts: {
  userCode: string;
  deviceCode?: string;
  expiresAt?: number;
}): Promise<string> {
  const deviceCode = opts.deviceCode ?? `dev_${crypto.randomUUID().replace(/-/g, "")}`;
  const expiresAt = opts.expiresAt ?? Date.now() + 10 * 60 * 1000;
  await env.DB.prepare(
    "INSERT INTO device_codes (device_code, user_code, expires_at) VALUES (?, ?, ?)"
  ).bind(deviceCode, opts.userCode, expiresAt).run();
  return deviceCode;
}
