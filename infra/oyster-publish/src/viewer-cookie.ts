// HMAC-SHA256 signed cookie for password-mode unlock.
// Spec: docs/superpowers/specs/2026-05-03-r5-viewer-design.md (Cookie scheme).
// Format: <token>.<unix_seconds>.<hmac_b64url>
//   - token is the share_token (asserted on verify; the cookie path also scopes it)
//   - hmac is over `${token}.${unix_seconds}` keyed by VIEWER_COOKIE_SECRET
//   - TTL is 24h (86400s); rejected if older.

const TTL_SECONDS = 86400;

export async function signViewerCookie(shareToken: string, secret: string): Promise<string> {
  return signViewerCookieAt(shareToken, secret, Math.floor(Date.now() / 1000));
}

export async function signViewerCookieAt(
  shareToken: string,
  secret: string,
  unixSeconds: number,
): Promise<string> {
  const hmac = await hmacSha256B64url(`${shareToken}.${unixSeconds}`, secret);
  return `${shareToken}.${unixSeconds}.${hmac}`;
}

export async function verifyViewerCookie(
  cookie: string,
  expectedToken: string,
  secret: string,
): Promise<boolean> {
  if (typeof cookie !== "string" || cookie.length === 0) return false;
  const parts = cookie.split(".");
  if (parts.length !== 3) return false;
  // tsconfig has noUncheckedIndexedAccess; the length check above guarantees
  // these three are defined, but TS doesn't narrow array length. Assert.
  const [token, tsRaw, hmacGot] = parts as [string, string, string];
  if (token !== expectedToken) return false;
  if (!/^\d+$/.test(tsRaw)) return false;
  const ts = Number(tsRaw);
  if (!Number.isSafeInteger(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - ts > TTL_SECONDS) return false;
  const hmacWant = await hmacSha256B64url(`${token}.${ts}`, secret);
  // Constant-time compare.
  return constantTimeEqual(hmacGot, hmacWant);
}

async function hmacSha256B64url(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return base64urlEncode(new Uint8Array(sig));
}

function base64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
