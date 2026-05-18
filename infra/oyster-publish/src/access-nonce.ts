// Short-lived, single-use access nonces for the viewer access redirect.
// Spec: docs/superpowers/specs/2026-05-18-viewer-access-redirect-design.md
//
// Mint: oyster.to/api/publish/access-redirect/<token> after the access
// predicate passes. Consume: share.oyster.to/p/<token>?key=<nonce> on the
// viewer pre-check. The atomic UPDATE pins share_token in the WHERE clause
// so a nonce minted for one share cannot consume against another.

import type { Env } from "./types";

const TTL_MS = 60_000;

/**
 * Mint a fresh nonce bound to (share_token, user_id). Also opportunistically
 * deletes expired rows. Returns the nonce — 22 base64url chars, 128 bits of
 * entropy.
 */
export async function mintAccessNonce(
  env: Env,
  shareToken: string,
  userId: string,
): Promise<string> {
  const now = Date.now();

  // Opportunistic cleanup. The expires_at index makes this a range scan;
  // the table is small (60s TTL bounds the steady-state size).
  await env.DB.prepare(
    "DELETE FROM viewer_access_nonces WHERE expires_at < ?",
  ).bind(now).run();

  const nonce = base64urlRandom(16);  // 16 bytes → 22 chars
  await env.DB.prepare(
    `INSERT INTO viewer_access_nonces
       (nonce, share_token, user_id, expires_at, consumed_at, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).bind(nonce, shareToken, userId, now + TTL_MS, now).run();
  return nonce;
}

/**
 * Returns true iff this call atomically transitioned the nonce for THIS
 * share_token from unconsumed-and-live to consumed. Wrong share_token,
 * wrong nonce, expired, or already-consumed all return false WITHOUT any
 * side effect on the row.
 */
export async function consumeAccessNonce(
  env: Env,
  nonce: string,
  shareToken: string,
): Promise<boolean> {
  const now = Date.now();
  const res = await env.DB.prepare(
    `UPDATE viewer_access_nonces
        SET consumed_at = ?
      WHERE nonce       = ?
        AND share_token = ?
        AND consumed_at IS NULL
        AND expires_at  > ?`,
  ).bind(now, nonce, shareToken, now).run();
  return (res.meta?.changes ?? 0) === 1;
}

function base64urlRandom(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
