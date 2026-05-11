// Env interface for the oyster-cloud Worker.
// Bindings declared in wrangler.toml.

export interface Env {
  DB: D1Database; // shared with oyster-auth (same database_id)
  // Session bytes (#322): per-user AES-GCM encrypted jsonl objects.
  SESSIONS_BUCKET: R2Bucket;
  // HKDF input keying material — provisioned via:
  //   wrangler secret put SESSIONS_ENCRYPTION_KEY
  // The actual AES key is derived per-user (salt = user id) so a leak of
  // one user's derived key never compromises another.
  SESSIONS_ENCRYPTION_KEY: string;
}

interface SessionUser {
  id: string;
  email: string;
  tier: string;
}

/**
 * Resolve the session cookie to a user. Returns null on missing/expired session.
 * Reads from the shared sessions + users tables.
 */
export async function resolveSession(req: Request, env: Env): Promise<SessionUser | null> {
  const cookie = req.headers.get("Cookie");
  if (!cookie) return null;
  const m = cookie.match(/(?:^|;\s*)oyster_session=([^;]+)/);
  if (!m) return null;
  const token = m[1];

  // Production sessions schema (infra/auth-worker/migrations/0001_init.sql):
  //   id TEXT PRIMARY KEY (the cookie value), user_id, created_at,
  //   expires_at, revoked_at. Live-row predicate matches auth-worker exactly:
  //   revoked_at IS NULL AND expires_at > now.
  const row = await env.DB.prepare(
    `SELECT u.id AS id, u.email AS email, u.tier AS tier
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ?`
  ).bind(token, Date.now()).first<{ id: string; email: string; tier: string }>();

  if (!row) return null;
  return { id: row.id, email: row.email, tier: row.tier };
}
