// Minimal test fixtures for oyster-cloud bootstrap tests.
// Each test file gets an isolated in-memory D1 binding via @cloudflare/vitest-pool-workers.

import { env } from "cloudflare:test";

const SCHEMA_SQL = `
-- Mirror of oyster-auth's relevant schema for tests. Keep in sync with:
--   infra/auth-worker/migrations/0001_init.sql  (users, sessions)
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  tier          TEXT NOT NULL DEFAULT 'free'
);
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER
)
`;

export async function applySchema(): Promise<void> {
  const stmts = SCHEMA_SQL.split(";").map(s => s.trim()).filter(Boolean);
  for (const s of stmts) {
    await env.DB.prepare(s).run();
  }
}
