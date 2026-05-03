// Test fixtures for oyster-publish integration tests.
// Each test file gets isolated D1 + R2 bindings via @cloudflare/vitest-pool-workers.

import { env } from "cloudflare:test";

const SCHEMA_SQL = `
-- Mirror of oyster-auth's relevant schema for tests. Keep in sync with:
--   infra/auth-worker/migrations/0001_init.sql  (users, sessions)
--   infra/auth-worker/migrations/0003_publish.sql (users.tier, published_artifacts)
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  tier          TEXT NOT NULL DEFAULT 'free'
);
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,                  -- cookie value (mirrors production)
  user_id       TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER                            -- NULL while active
);
CREATE TABLE published_artifacts (
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
CREATE INDEX idx_pubart_owner ON published_artifacts(owner_user_id);
CREATE UNIQUE INDEX idx_pubart_active_per_owner_artifact
  ON published_artifacts(owner_user_id, artifact_id)
  WHERE unpublished_at IS NULL;
`;

export async function applySchema(): Promise<void> {
  // D1 .exec runs multi-statement SQL but ignores comments inconsistently;
  // split on semicolons and run each non-empty statement.
  const stmts = SCHEMA_SQL.split(";").map(s => s.trim()).filter(Boolean);
  for (const s of stmts) {
    await env.DB.prepare(s).run();
  }
}

export interface SeededUser {
  id: string;
  email: string;
  sessionToken: string;
}

export async function seedUser(opts: { id?: string; email?: string; tier?: string } = {}): Promise<SeededUser> {
  const id = opts.id ?? `user_${crypto.randomUUID().slice(0, 8)}`;
  const email = opts.email ?? `${id}@example.com`;
  const tier = opts.tier ?? "free";
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO users (id, email, created_at, last_seen_at, tier) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, email, now, now, tier).run();

  const sessionToken = `sess_${crypto.randomUUID()}`;
  const expiresAt = now + 30 * 86400 * 1000;
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(sessionToken, id, now, expiresAt).run();

  return { id, email, sessionToken };
}

export async function seedActivePublication(opts: {
  ownerUserId: string;
  artifactId: string;
  shareToken?: string;
  mode?: "open" | "password" | "signin";
  passwordHash?: string | null;
  publishedAt?: number;
}): Promise<string> {
  const token = opts.shareToken ?? `seeded_${crypto.randomUUID().slice(0, 8)}`;
  const mode = opts.mode ?? "open";
  const passwordHash = mode === "password" ? (opts.passwordHash ?? "pbkdf2$100000$x$y") : null;
  const now = opts.publishedAt ?? Date.now();
  await env.DB.prepare(
    `INSERT INTO published_artifacts
     (share_token, owner_user_id, artifact_id, artifact_kind, mode, password_hash,
      r2_key, content_type, size_bytes, published_at, updated_at, unpublished_at)
     VALUES (?, ?, ?, 'notes', ?, ?, ?, 'text/plain', 5, ?, ?, NULL)`
  ).bind(token, opts.ownerUserId, opts.artifactId, mode, passwordHash,
         `published/${opts.ownerUserId}/${token}`, now, now).run();
  return token;
}

export function authHeader(sessionToken: string): { Cookie: string } {
  return { Cookie: `oyster_session=${sessionToken}` };
}

export function metadataHeader(payload: object): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export async function retirePublication(shareToken: string, unpublishedAt = Date.now()): Promise<void> {
  await env.DB.prepare(
    "UPDATE published_artifacts SET unpublished_at = ? WHERE share_token = ?",
  ).bind(unpublishedAt, shareToken).run();
}

export async function putR2Object(key: string, body: Uint8Array | string, contentType: string): Promise<void> {
  await env.ARTIFACTS.put(key, body, { httpMetadata: { contentType } });
}

export async function seedActiveOpenWithBody(opts: {
  ownerUserId: string;
  artifactId: string;
  artifactKind?: "notes" | "diagram" | "app" | "deck" | "wireframe" | "table" | "map";
  contentType?: string;
  body: string | Uint8Array;
  shareToken?: string;
  publishedAt?: number;
}): Promise<{ shareToken: string; r2Key: string }> {
  const token = opts.shareToken ?? `seeded_${crypto.randomUUID().slice(0, 8)}`;
  const kind = opts.artifactKind ?? "notes";
  const contentType = opts.contentType ?? "text/markdown";
  const now = opts.publishedAt ?? Date.now();
  const r2Key = `published/${opts.ownerUserId}/${token}`;
  const sizeBytes = typeof opts.body === "string"
    ? new TextEncoder().encode(opts.body).byteLength
    : opts.body.byteLength;
  await env.DB.prepare(
    `INSERT INTO published_artifacts
     (share_token, owner_user_id, artifact_id, artifact_kind, mode, password_hash,
      r2_key, content_type, size_bytes, published_at, updated_at, unpublished_at)
     VALUES (?, ?, ?, ?, 'open', NULL, ?, ?, ?, ?, ?, NULL)`,
  ).bind(token, opts.ownerUserId, opts.artifactId, kind, r2Key, contentType, sizeBytes, now, now).run();
  await putR2Object(r2Key, opts.body, contentType);
  return { shareToken: token, r2Key };
}
