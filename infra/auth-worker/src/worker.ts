// Oyster auth worker — Cloudflare-native magic-link auth and (in PR 3)
// device-flow bridge to the local server at localhost:4444. See
// docs/plans/auth.md for the full design.

import { pkceVerifier, codeChallengeS256, pickPrimaryVerifiedEmail, type GitHubEmail } from "./oauth-helpers";
import { validateReturnPath } from "./return-path";
//
// PR 2 endpoints:
//   GET  /auth/sign-in       HTML form (also accepts ?d=<user_code> for the device flow)
//   POST /auth/magic-link    {email, user_code?} — send the email
//   GET  /auth/verify?t=...  consume the token, set the session cookie, redirect
//   GET  /auth/welcome       landing page after verify (shows the signed-in email)
//   GET  /auth/whoami        {id, email} for a valid session, 401 otherwise
//
// PR 3 will add /auth/device-init, /auth/device/<code>, /auth/sign-out.

interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  MAGIC_LINK_LIMIT: RateLimit;
  // Optional so wrangler dev works without a Resend secret — sendMagicLink()
  // logs the verify URL to the Worker console when this is unset.
  RESEND_API_KEY?: string;
  FROM_ADDRESS?: string;
  REPLY_TO?: string;
  // GitHub OAuth. Both empty until the OAuth App is registered; handlers
  // check both and 503 if either is missing (handled in Phase 2).
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
}

// Magic-link tokens are always 43 chars (32 bytes base64url, no padding).
// Cap the input well above that to keep `?t=<huge>` from wasting CPU on
// the sha256, but loose enough to tolerate URL-encoding wraps and future
// token-length changes.
const MAX_TOKEN_LEN = 100;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 5 * 60 * 1000;
const MAX_USER_CODE_LEN = 32;
// Per-email cap: count of valid (non-expired) magic-link tokens for the user.
// Window = TTL so a single SQL count answers both questions ("issued in the
// last N minutes" ≡ "still valid"). Locks for the full TTL once 3 are out;
// any expiry frees a slot.
const PER_EMAIL_CAP = 3;
const COOKIE_NAME = "oyster_session";

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

function htmlResponse(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...extra },
  });
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>
  )[c]!);
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(byteLen = 32): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

interface UserRow { id: string; email: string }
interface SessionRow { id: string; user_id: string; expires_at: number; revoked_at: number | null }

async function findOrCreateUser(db: D1Database, email: string, now: number): Promise<UserRow> {
  // INSERT OR IGNORE then SELECT — D1 supports RETURNING, but the two-step
  // form is more portable across SQLite-likes and the SELECT is required
  // anyway when the row already exists.
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT OR IGNORE INTO users (id, email, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .bind(id, email, now, now)
    .run();
  const row = await db
    .prepare("SELECT id, email FROM users WHERE email = ?")
    .bind(email)
    .first<UserRow>();
  if (!row) throw new Error("user upsert failed");
  return row;
}

async function getSession(db: D1Database, sessionId: string, now: number): Promise<{ session: SessionRow; user: UserRow } | null> {
  const row = await db
    .prepare(
      `SELECT s.id, s.user_id, s.expires_at, s.revoked_at, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ?`
    )
    .bind(sessionId, now)
    .first<SessionRow & { email: string }>();
  if (!row) return null;
  return {
    session: { id: row.id, user_id: row.user_id, expires_at: row.expires_at, revoked_at: row.revoked_at },
    user: { id: row.user_id, email: row.email },
  };
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host.startsWith("localhost:") || host.startsWith("127.0.0.1:");
}

// Cookie shape adapts to the request host so wrangler dev (http://localhost:8787)
// can exercise the cookie flow. Production: Domain=.oyster.to + Secure so the
// cookie is visible on the apex and any subdomain the publish/viewer flows
// might end up on. Localhost: omit Domain (browsers reject Domain= on
// localhost) and omit Secure (no HTTPS). HttpOnly + SameSite=Lax stay on both.
function sessionCookie(sessionId: string, host: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  if (isLocalHost(host)) {
    return `${COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  }
  return `${COOKIE_NAME}=${sessionId}; Domain=.oyster.to; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearedCookie(host: string): string {
  if (isLocalHost(host)) {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }
  return `${COOKIE_NAME}=; Domain=.oyster.to; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

const NO_STORE: Record<string, string> = { "cache-control": "no-store" };

const GITHUB_MARK_SVG = `<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" style="vertical-align: -4px; margin-right: 0.5rem;"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.4 3-.405 1.02.005 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>`;

const SIGN_IN_HTML = (userCode: string | null, returnPath: string | null) => {
  const githubHref = userCode
    ? `/auth/github/start?d=${encodeURIComponent(userCode)}`
    : returnPath
      ? `/auth/github/start?return=${encodeURIComponent(returnPath)}`
      : "/auth/github/start";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to Oyster</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 28rem; margin: 6rem auto; padding: 0 1.5rem; line-height: 1.5; }
  h1 { font-size: 1.5rem; margin: 0 0 1.5rem; }
  .gh-button { display: flex; align-items: center; justify-content: center; padding: 0.7rem 1rem; font-size: 1rem; font-weight: 600; border: 0; border-radius: 0.4rem; background: #24292f; color: #ffffff; text-decoration: none; cursor: pointer; }
  .gh-button:hover { background: #32383f; }
  .divider { display: flex; align-items: center; gap: 0.75rem; margin: 1.5rem 0; font-size: 0.85rem; opacity: 0.6; }
  .divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: currentColor; opacity: 0.25; }
  form { display: flex; flex-direction: column; gap: 0.75rem; }
  label { font-size: 0.85rem; opacity: 0.7; }
  input[type=email] { padding: 0.6rem 0.75rem; font-size: 1rem; border: 1px solid #888; border-radius: 0.4rem; background: transparent; color: inherit; }
  button[type=submit] { padding: 0.6rem 0.75rem; font-size: 1rem; font-weight: 500; border: 0; border-radius: 0.4rem; background: transparent; color: inherit; border: 1px solid #888; cursor: pointer; }
  button[type=submit]:disabled { opacity: 0.5; cursor: not-allowed; }
  #status { margin-top: 1rem; font-size: 0.9rem; }
  .ok { color: #2e7d32; }
  .err { color: #c62828; }
</style>
</head><body>
<h1>Sign in to Oyster</h1>
<a class="gh-button" href="${githubHref}">${GITHUB_MARK_SVG}Continue with GitHub</a>
<div class="divider">or use email</div>
<form id="f">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required autocomplete="email">
  <input type="hidden" id="return_path" name="return_path" value="${returnPath ? returnPath.replace(/[<>"]/g, "") : ""}">
  <button type="submit">Send magic link</button>
</form>
<p id="status" hidden></p>
<script>
const f = document.getElementById('f');
const s = document.getElementById('status');
const userCode = ${userCode ? JSON.stringify(userCode) : "null"};
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = f.email.value.trim();
  const returnPath = document.getElementById('return_path').value || null;
  const btn = f.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await fetch('/auth/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, user_code: userCode, return_path: returnPath }),
    });
    if (res.ok) {
      f.style.display = 'none';
      s.hidden = false;
      s.className = 'ok';
      s.textContent = 'Check your inbox for a sign-in link. The link expires in 15 minutes.';
    } else {
      let errorCode = '';
      try { errorCode = ((await res.json()) || {}).error || ''; } catch {}
      s.hidden = false;
      s.className = 'err';
      s.textContent = errorCode === 'handoff_expired'
        ? 'This sign-in request expired. Return to the Oyster app and start sign-in again.'
        : 'Could not send the link. Check the email and try again.';
      btn.disabled = false;
      btn.textContent = 'Send magic link';
    }
  } catch {
    s.hidden = false;
    s.className = 'err';
    s.textContent = 'Network error. Try again.';
    btn.disabled = false;
    btn.textContent = 'Send magic link';
  }
});
</script>
</body></html>`;
};

const WELCOME_HTML = (email: string, deviceLogin: boolean) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signed in to Oyster</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 28rem; margin: 6rem auto; padding: 0 1.5rem; line-height: 1.5; text-align: center; }
  h1 { font-size: 1.5rem; }
  code { background: rgba(127,127,127,0.15); padding: 0.1em 0.3em; border-radius: 0.25rem; }
</style>
</head><body>
<h1>You're signed in</h1>
<p>Signed in as <code>${htmlEscape(email)}</code>.</p>
${deviceLogin
  ? "<p>You can close this window — your local Oyster app will pick up the session automatically.</p>"
  : "<p><a href=\"https://oyster.to/\">← Back to Oyster</a></p>"}
</body></html>`;

const SIGN_IN_ERROR_HTML = (message: string) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Sign in failed</title>
<style>body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 6rem auto; padding: 0 1.5rem; }</style>
</head><body>
<h1>Sign in failed</h1>
<p>${htmlEscape(message)}</p>
<p><a href="/auth/sign-in">Try again</a></p>
</body></html>`;

const SIGN_IN_EXPIRED_HTML = (hadLocalHandoff: boolean) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign-in request expired</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 28rem; margin: 6rem auto; padding: 0 1.5rem; line-height: 1.5; text-align: center; }
  h1 { font-size: 1.5rem; }
  button, .btn { padding: 0.6rem 1rem; font-size: 1rem; font-weight: 600; border: 0; border-radius: 0.4rem; background: #6750a4; color: #fff; cursor: pointer; text-decoration: none; display: inline-block; }
</style>
</head><body>
<h1>Sign-in request expired</h1>
${hadLocalHandoff
  ? "<p>Return to the Oyster app and start sign-in again.</p><button onclick=\"window.close()\" class=\"btn\">Close this window</button>"
  : "<p>This sign-in link is no longer valid.</p><a href=\"/auth/sign-in\" class=\"btn\">Sign in again</a>"}
</body></html>`;

async function sendMagicLink(env: Env, email: string, link: string): Promise<void> {
  // Dev fallback: no Resend key configured → log the verify URL so a
  // local maintainer can complete the flow without Resend setup.
  // Never trips in production because deploy fails without the secret.
  if (!env.RESEND_API_KEY) {
    console.log(`[magic-link] no RESEND_API_KEY; verify URL for ${email}: ${link}`);
    return;
  }
  const from = env.FROM_ADDRESS ?? "noreply@oyster.to";
  const replyTo = env.REPLY_TO ?? "matthew@slight.me";
  const subject = "Sign in to Oyster";
  const text =
    "Click the link below to sign in to Oyster. The link is single-use and expires in 15 minutes.\n\n" +
    `${link}\n\n` +
    "If you didn't request this, ignore this email — no account changes were made.";
  const html =
    `<p>Click the link below to sign in to Oyster. The link is single-use and expires in 15 minutes.</p>` +
    `<p><a href="${htmlEscape(link)}" style="display:inline-block;padding:0.6rem 1rem;background:#6750a4;color:#fff;text-decoration:none;border-radius:0.4rem;font-weight:600;">Sign in to Oyster</a></p>` +
    `<p style="font-size:0.85rem;color:#666;">Or paste this URL into your browser:<br><code>${htmlEscape(link)}</code></p>` +
    `<p style="font-size:0.85rem;color:#666;">If you didn't request this, ignore this email — no account changes were made.</p>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: `Oyster <${from}>`,
      to: email,
      reply_to: replyTo,
      subject,
      text,
      html,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("resend_failed", res.status, detail);
    throw new Error(`resend ${res.status}`);
  }
}

async function handleMagicLink(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  // Per-IP gate first — cheapest reject path. The Workers Rate Limit
  // binding does the bookkeeping at the edge; no D1 row needed.
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const ipGate = await env.MAGIC_LINK_LIMIT.limit({ key: ip });
  if (!ipGate.success) return json({ error: "rate_limited" }, 429);

  let payload: { email?: unknown; user_code?: unknown };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const rawEmail = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(rawEmail) || rawEmail.length > 254) {
    return json({ error: "invalid_email" }, 400);
  }
  const userCode =
    typeof payload.user_code === "string" && payload.user_code.length > 0
      ? payload.user_code
      : null;

  const now = Date.now();
  const user = await findOrCreateUser(env.DB, rawEmail, now);

  // Per-email cap: count of still-valid tokens for this user.
  const live = await env.DB
    .prepare("SELECT count(*) AS n FROM magic_link_tokens WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?")
    .bind(user.id, now)
    .first<{ n: number }>();
  if ((live?.n ?? 0) >= PER_EMAIL_CAP) {
    // Silent no-op — return ok so the response is identical regardless
    // of whether the email is mid-flood. No leak about cap state.
    return json({ ok: true });
  }

  // Resolve user_code → device_code if present. Mirrors the fail-closed
  // rule on /auth/github/start: an invalid/expired/already-attached/
  // already-claimed user_code aborts here with handoff_expired rather
  // than degrading to a non-device login (which would split-brain the
  // browser-says-success / local-keeps-polling UX).
  let deviceCode: string | null = null;
  if (userCode) {
    if (userCode.length > MAX_USER_CODE_LEN) {
      return json({ error: "handoff_expired" }, 400, NO_STORE);
    }
    const dc = await env.DB
      .prepare("SELECT device_code, session_id, claimed_at, expires_at FROM device_codes WHERE user_code = ?")
      .bind(userCode)
      .first<{ device_code: string; session_id: string | null; claimed_at: number | null; expires_at: number }>();
    if (!dc || dc.expires_at <= now || dc.session_id !== null || dc.claimed_at !== null) {
      return json({ error: "handoff_expired" }, 400, NO_STORE);
    }
    deviceCode = dc.device_code;
  }

  const rawToken = randomToken(32);
  const tokenHash = await sha256Hex(rawToken);
  const expiresAt = now + MAGIC_LINK_TTL_MS;
  await env.DB
    .prepare("INSERT INTO magic_link_tokens (token_hash, user_id, device_code, expires_at) VALUES (?, ?, ?, ?)")
    .bind(tokenHash, user.id, deviceCode, expiresAt)
    .run();

  const verifyUrl = `${url.origin}/auth/verify?t=${encodeURIComponent(rawToken)}`;
  // Fire the email asynchronously so the response doesn't block on Resend.
  // On failure, delete the token row — otherwise a failed send burns a
  // slot in the per-email cap until the 15-min TTL clears.
  ctx.waitUntil(
    sendMagicLink(env, rawEmail, verifyUrl).catch(async (err) => {
      console.error("send_failed", err);
      await env.DB
        .prepare("DELETE FROM magic_link_tokens WHERE token_hash = ?")
        .bind(tokenHash)
        .run()
        .catch((cleanupErr) => console.error("cleanup_failed", cleanupErr));
    })
  );
  return json({ ok: true });
}

async function handleVerify(env: Env, url: URL): Promise<Response> {
  const raw = url.searchParams.get("t");
  if (!raw || raw.length > MAX_TOKEN_LEN) {
    return htmlResponse(SIGN_IN_ERROR_HTML("Missing or invalid sign-in link."), 400, NO_STORE);
  }

  const tokenHash = await sha256Hex(raw);
  const now = Date.now();

  // Atomic consume. The WHERE clause is the gate: only an unconsumed,
  // unexpired token marks itself as used here. RETURNING gives us the
  // user_id / device_code in one round-trip — the email comes from a
  // separate SELECT below since RETURNING in SQLite can't join.
  // Two concurrent verify requests can't both pass: only one will see
  // meta.changes === 1 (or the RETURNING row); the other races and
  // sees nothing back.
  const consumed = await env.DB
    .prepare(
      `UPDATE magic_link_tokens
         SET consumed_at = ?
       WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
       RETURNING user_id, device_code`
    )
    .bind(now, tokenHash, now)
    .first<{ user_id: string; device_code: string | null }>();

  if (!consumed) {
    return htmlResponse(
      SIGN_IN_ERROR_HTML("This sign-in link is invalid, expired, or has already been used. Sign-in links are single-use and valid for 15 minutes."),
      400,
      NO_STORE,
    );
  }

  const userRow = await env.DB
    .prepare("SELECT email FROM users WHERE id = ?")
    .bind(consumed.user_id)
    .first<{ email: string }>();
  if (!userRow) {
    return htmlResponse(SIGN_IN_ERROR_HTML("Account not found."), 400, NO_STORE);
  }

  const sessionId = crypto.randomUUID();
  const sessionExpires = now + SESSION_TTL_MS;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(sessionId, consumed.user_id, now, sessionExpires),
    env.DB.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").bind(now, consumed.user_id),
  ]);

  // If this token was issued via the device flow, attach the session
  // to the device_codes row so the local server's poller (PR 3) can
  // pick it up. The expires_at predicate prevents claiming a stale
  // device-code row that was abandoned past its 10-min window.
  if (consumed.device_code) {
    await env.DB
      .prepare(
        "UPDATE device_codes SET session_id = ? WHERE device_code = ? AND session_id IS NULL AND expires_at > ?"
      )
      .bind(sessionId, consumed.device_code, now)
      .run();
  }

  const cookie = sessionCookie(sessionId, url.host);

  // Browser-only logins: redirect to /auth/welcome with the cookie set.
  // Device-flow logins: render the welcome page directly so the user
  // sees the "you can close this window" copy without an extra hop.
  if (consumed.device_code) {
    return htmlResponse(WELCOME_HTML(userRow.email, true), 200, {
      "set-cookie": cookie,
      ...NO_STORE,
    });
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: "/auth/welcome",
      "set-cookie": cookie,
      ...NO_STORE,
    },
  });
}

async function handleWelcome(req: Request, env: Env, host: string): Promise<Response> {
  const cookies = parseCookies(req);
  const sid = cookies[COOKIE_NAME];
  if (!sid) {
    return htmlResponse(SIGN_IN_ERROR_HTML("No active session — sign in to continue."), 401, NO_STORE);
  }
  const lookup = await getSession(env.DB, sid, Date.now());
  if (!lookup) {
    return htmlResponse(SIGN_IN_ERROR_HTML("Your session has expired. Sign in again."), 401, {
      "set-cookie": clearedCookie(host),
      ...NO_STORE,
    });
  }
  return htmlResponse(WELCOME_HTML(lookup.user.email, false), 200, NO_STORE);
}

// Device-flow handoff window: how long a device_code is valid for. Matches
// docs/plans/auth.md (10 min — long enough for a slow inbox, short enough
// that abandoned codes don't litter the table).
const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;

// 8 chars, base32-Crockford-ish (no confusable I/L/O/0/1). Rendered to
// the user as `XXXX-XXXX` in the sign-in URL — readable and short
// enough to be paste-friendly even if the auto-open browser fails.
const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomState(): string {
  return randomToken(32);  // existing helper produces 43-char base64url; reusable as state.
}

function randomUserCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
    if (i === 3) out += "-";
  }
  return out;
}

async function handleDeviceInit(req: Request, env: Env): Promise<Response> {
  // Per-IP gate. Reuses the same rate-limit binding as /auth/magic-link —
  // both endpoints are auth-attempt surface and an abuser hitting either
  // is the same problem. Cap is 20/hour per IP across both.
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const ipGate = await env.MAGIC_LINK_LIMIT.limit({ key: ip });
  if (!ipGate.success) return json({ error: "rate_limited" }, 429, NO_STORE);

  const now = Date.now();
  const expiresAt = now + DEVICE_CODE_TTL_MS;

  // Opportunistic GC: delete a small batch of expired rows on every
  // init. Bounded LIMIT so a single request never spends too long; over
  // many requests the table stays trimmed without a separate cron Worker.
  await env.DB
    .prepare("DELETE FROM device_codes WHERE expires_at < ? LIMIT 100")
    .bind(now)
    .run()
    .catch((err) => console.error("device_codes_gc_failed", err));

  // user_code has UNIQUE — retry on the rare collision rather than
  // letting a duplicate slip through.
  for (let attempt = 0; attempt < 4; attempt++) {
    const deviceCode = randomToken(32);
    const userCode = randomUserCode();
    try {
      await env.DB
        .prepare("INSERT INTO device_codes (device_code, user_code, expires_at) VALUES (?, ?, ?)")
        .bind(deviceCode, userCode, expiresAt)
        .run();
      return json({
        device_code: deviceCode,
        user_code: userCode,
        expires_in: Math.floor(DEVICE_CODE_TTL_MS / 1000),
      }, 200, NO_STORE);
    } catch (err) {
      if (attempt === 3) throw err;
      // UNIQUE collision on user_code or device_code; retry.
    }
  }
  return json({ error: "device_init_failed" }, 500, NO_STORE);
}

async function handleDevicePoll(env: Env, deviceCode: string): Promise<Response> {
  if (!deviceCode || deviceCode.length > MAX_TOKEN_LEN) {
    return json({ error: "invalid_device_code" }, 400, NO_STORE);
  }
  const now = Date.now();

  // Load the user FIRST. The previous version marked claimed_at before
  // fetching the user row; if the user fetch (or any subsequent step)
  // failed, the row was burnt — every retry returned 410 already_claimed
  // and the login was lost. Now: read everything we need to respond,
  // *then* race to claim. A failed read returns the same status the
  // poller already handles (404 → "unknown" → 410); only the atomic
  // UPDATE+meta.changes is the gate.
  const candidate = await env.DB
    .prepare(
      `SELECT d.session_id, d.claimed_at, d.expires_at, u.id AS user_id, u.email
       FROM device_codes d
       LEFT JOIN sessions s ON s.id = d.session_id AND s.revoked_at IS NULL AND s.expires_at > ?
       LEFT JOIN users u ON u.id = s.user_id
       WHERE d.device_code = ?`
    )
    .bind(now, deviceCode)
    .first<{ session_id: string | null; claimed_at: number | null; expires_at: number; user_id: string | null; email: string | null }>();

  if (!candidate) return json({ error: "unknown_device_code" }, 410, NO_STORE);
  if (candidate.claimed_at !== null) return json({ error: "already_claimed" }, 410, NO_STORE);
  if (candidate.expires_at <= now) return json({ error: "expired" }, 410, NO_STORE);
  if (candidate.session_id === null) return json({ status: "pending" }, 202, NO_STORE);
  if (!candidate.user_id || !candidate.email) {
    // Session was revoked between verify and poll. Don't burn the row.
    return json({ error: "session_unavailable" }, 410, NO_STORE);
  }

  // Atomic claim. Only one concurrent poll wins.
  const res = await env.DB
    .prepare(
      "UPDATE device_codes SET claimed_at = ? WHERE device_code = ? AND claimed_at IS NULL AND session_id = ?"
    )
    .bind(now, deviceCode, candidate.session_id)
    .run();
  if ((res.meta?.changes ?? 0) !== 1) {
    return json({ error: "already_claimed" }, 410, NO_STORE);
  }

  return json(
    { session_token: candidate.session_id, user: { id: candidate.user_id, email: candidate.email } },
    200,
    NO_STORE,
  );
}

async function handleSignOut(req: Request, env: Env, host: string): Promise<Response> {
  // Accept the session token from either the cookie (browser) or a
  // Bearer header (local server / CLI). Either revokes the same row.
  const cookies = parseCookies(req);
  const fromCookie = cookies[COOKIE_NAME];
  const auth = req.headers.get("authorization") ?? "";
  const fromBearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const sid = fromCookie || fromBearer;
  if (!sid) {
    return json({ ok: true }, 200, { "set-cookie": clearedCookie(host), ...NO_STORE });
  }
  await env.DB
    .prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(Date.now(), sid)
    .run();
  return json({ ok: true }, 200, { "set-cookie": clearedCookie(host), ...NO_STORE });
}

async function handleWhoami(req: Request, env: Env, host: string): Promise<Response> {
  // Accept either the browser cookie or a Bearer header from the local
  // server. Same session row backs both.
  const cookies = parseCookies(req);
  const fromCookie = cookies[COOKIE_NAME];
  const auth = req.headers.get("authorization") ?? "";
  const fromBearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const sid = fromCookie || fromBearer;
  if (!sid) return json({ error: "unauthenticated" }, 401, NO_STORE);
  const lookup = await getSession(env.DB, sid, Date.now());
  if (!lookup) {
    return json({ error: "unauthenticated" }, 401, { "set-cookie": clearedCookie(host), ...NO_STORE });
  }
  return json({ id: lookup.user.id, email: lookup.user.email }, 200, NO_STORE);
}

async function handleGithubStart(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) {
    return json({ error: "oauth_not_configured" }, 503, NO_STORE);
  }

  // Per-IP gate. Reuses MAGIC_LINK_LIMIT — same auth-attempt budget as
  // /auth/magic-link and /auth/device-init.
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const ipGate = await env.MAGIC_LINK_LIMIT.limit({ key: ip });
  if (!ipGate.success) {
    return htmlResponse(
      SIGN_IN_ERROR_HTML("Too many sign-in attempts. Please try again shortly."),
      429,
      NO_STORE,
    );
  }

  const userCode = url.searchParams.get("d");
  const now = Date.now();

  // If ?d= is present, validate before redirecting to GitHub. Saves a
  // wasted OAuth round-trip when the local handoff is already dead.
  if (userCode) {
    if (userCode.length > MAX_USER_CODE_LEN) {
      return htmlResponse(SIGN_IN_EXPIRED_HTML(false), 400, NO_STORE);
    }
    const dc = await env.DB
      .prepare("SELECT device_code, session_id, claimed_at, expires_at FROM device_codes WHERE user_code = ?")
      .bind(userCode)
      .first<{ device_code: string; session_id: string | null; claimed_at: number | null; expires_at: number }>();
    if (!dc || dc.expires_at <= now || dc.session_id !== null || dc.claimed_at !== null) {
      return htmlResponse(SIGN_IN_EXPIRED_HTML(true), 400, NO_STORE);
    }
  }

  const state = randomState();
  const verifier = pkceVerifier();
  const challenge = await codeChallengeS256(verifier);

  await env.DB
    .prepare(
      "INSERT INTO oauth_states (state, provider, pkce_verifier, user_code, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(state, "github", verifier, userCode, now, now + OAUTH_STATE_TTL_MS)
    .run();

  const githubUrl = new URL("https://github.com/login/oauth/authorize");
  githubUrl.searchParams.set("client_id", env.GITHUB_OAUTH_CLIENT_ID);
  githubUrl.searchParams.set("redirect_uri", `${url.origin}/auth/github/callback`);
  githubUrl.searchParams.set("scope", "user:email");
  githubUrl.searchParams.set("state", state);
  githubUrl.searchParams.set("code_challenge", challenge);
  githubUrl.searchParams.set("code_challenge_method", "S256");
  githubUrl.searchParams.set("allow_signup", "true");

  return new Response(null, {
    status: 302,
    headers: { location: githubUrl.toString(), ...NO_STORE },
  });
}

interface GitHubUser {
  id: number;
  login: string;
}

async function exchangeGithubCode(env: Env, code: string, verifier: string, redirectUri: string): Promise<string | null> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    console.error("github_token_exchange_failed", res.status);
    return null;
  }
  const body = await res.json().catch(() => null) as { access_token?: string } | null;
  return body?.access_token ?? null;
}

async function fetchGithubUser(token: string): Promise<GitHubUser | null> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": "oyster-auth",
      accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    console.error("github_user_fetch_failed", res.status);
    return null;
  }
  const body = await res.json().catch(() => null) as { id?: number; login?: string } | null;
  if (!body || typeof body.id !== "number" || typeof body.login !== "string") return null;
  return { id: body.id, login: body.login };
}

async function fetchGithubEmails(token: string): Promise<GitHubEmail[] | null> {
  const res = await fetch("https://api.github.com/user/emails", {
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": "oyster-auth",
      accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    console.error("github_emails_fetch_failed", res.status);
    return null;
  }
  const body = await res.json().catch(() => null);
  if (!Array.isArray(body)) return null;
  return body as GitHubEmail[];
}

interface ResolvedIdentity {
  user_id: string;
  email_for_session: string;  // the email we'll show on the welcome page (current users.email after STEP 1's update)
}

async function resolveIdentity(
  db: D1Database,
  provider: string,
  providerUserId: string,
  providerEmail: string,
  now: number,
): Promise<ResolvedIdentity> {
  // STEP 1 — identity match. provider_user_id is the truth.
  const identityRow = await db
    .prepare("SELECT user_id FROM user_identities WHERE provider = ? AND provider_user_id = ?")
    .bind(provider, providerUserId)
    .first<{ user_id: string }>();

  if (identityRow) {
    await db
      .prepare(
        "UPDATE user_identities SET provider_email = ?, last_seen_at = ? WHERE provider = ? AND provider_user_id = ?",
      )
      .bind(providerEmail, now, provider, providerUserId)
      .run();

    // Try to update users.email to the current verified primary. If
    // another users row already owns this email, keep ours unchanged
    // and log the conflict — sign-in still succeeds. last_seen_at is
    // bumped by the session-create batch in handleGithubCallback, not
    // here, so this UPDATE is email-only.
    let emailForSession = providerEmail;
    try {
      const updateRes = await db
        .prepare("UPDATE users SET email = ? WHERE id = ?")
        .bind(providerEmail, identityRow.user_id)
        .run();
      // Note: D1 lets the UPDATE succeed even if the new value equals
      // the old; meta.changes reflects rows actually changed by storage.
      // We don't need to branch on that.
      void updateRes;
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      if (/UNIQUE constraint failed/.test(message)) {
        const conflictRow = await db
          .prepare("SELECT id, email FROM users WHERE email = ?")
          .bind(providerEmail)
          .first<{ id: string; email: string }>();
        const ourRow = await db
          .prepare("SELECT email FROM users WHERE id = ?")
          .bind(identityRow.user_id)
          .first<{ email: string }>();
        console.warn(JSON.stringify({
          kind: "oauth_email_conflict",
          provider,
          provider_user_id: providerUserId,
          user_id: identityRow.user_id,
          conflicting_user_id: conflictRow?.id ?? null,
          attempted_email: providerEmail,
          kept_email: ourRow?.email ?? null,
        }));
        emailForSession = ourRow?.email ?? providerEmail;
      } else {
        throw err;
      }
    }

    return { user_id: identityRow.user_id, email_for_session: emailForSession };
  }

  // STEP 2 — first-time link, email match. With a short retry on the
  // STEP 3 INSERT to handle the rare concurrent first-link race for
  // the same email.
  for (let attempt = 0; attempt < 3; attempt++) {
    const userRow = await db
      .prepare("SELECT id FROM users WHERE email = ?")
      .bind(providerEmail)
      .first<{ id: string }>();

    if (userRow) {
      // Existing user — link the GitHub identity to it. INSERT OR
      // IGNORE so two concurrent callbacks for the same GitHub account
      // (rare double-click race) both succeed: one inserts, the other
      // no-ops. Both arrive at the same returned user_id.
      await db
        .prepare(
          `INSERT OR IGNORE INTO user_identities
             (provider, provider_user_id, user_id, provider_email, linked_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(provider, providerUserId, userRow.id, providerEmail, now, now)
        .run();
      return { user_id: userRow.id, email_for_session: providerEmail };
    }

    // STEP 3 — first-time link, no existing user.
    const newUserId = crypto.randomUUID();
    try {
      await db.batch([
        db.prepare("INSERT INTO users (id, email, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
          .bind(newUserId, providerEmail, now, now),
        db.prepare(
          `INSERT INTO user_identities
             (provider, provider_user_id, user_id, provider_email, linked_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(provider, providerUserId, newUserId, providerEmail, now, now),
      ]);
      return { user_id: newUserId, email_for_session: providerEmail };
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      if (!/UNIQUE constraint failed/.test(message)) throw err;
      // Concurrent first-link by email — retry, STEP 2 will hit this time.
    }
  }

  throw new Error("identity_resolution_failed_after_retries");
}

async function handleGithubCallback(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) {
    return json({ error: "oauth_not_configured" }, 503, NO_STORE);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || state.length > 200) {
    return htmlResponse(SIGN_IN_EXPIRED_HTML(false), 400, NO_STORE);
  }

  const now = Date.now();

  // Atomic state consume. Two concurrent callbacks for the same state
  // cannot both pass — only one sees the RETURNING row. Scope by
  // provider in the WHERE clause so a state minted by a future
  // /auth/<other-provider>/start can never be consumed here, even if
  // an attacker forces a callback URL collision.
  const stateRow = await env.DB
    .prepare(
      `UPDATE oauth_states
          SET consumed_at = ?
        WHERE state = ? AND provider = ? AND consumed_at IS NULL AND expires_at > ?
        RETURNING pkce_verifier, user_code`,
    )
    .bind(now, state, "github", now)
    .first<{ pkce_verifier: string; user_code: string | null }>();

  if (!stateRow) {
    return htmlResponse(SIGN_IN_EXPIRED_HTML(false), 400, NO_STORE);
  }

  const redirectUri = `${url.origin}/auth/github/callback`;
  const accessToken = await exchangeGithubCode(env, code, stateRow.pkce_verifier, redirectUri);
  if (!accessToken) {
    return htmlResponse(SIGN_IN_ERROR_HTML("Sign-in failed. Please try again."), 502, NO_STORE);
  }

  const ghUser = await fetchGithubUser(accessToken);
  if (!ghUser) {
    return htmlResponse(SIGN_IN_ERROR_HTML("Sign-in failed. Please try again."), 502, NO_STORE);
  }

  const ghEmails = await fetchGithubEmails(accessToken);
  if (!ghEmails) {
    return htmlResponse(SIGN_IN_ERROR_HTML("Sign-in failed. Please try again."), 502, NO_STORE);
  }

  const primaryEmail = pickPrimaryVerifiedEmail(ghEmails);
  if (!primaryEmail) {
    return htmlResponse(
      SIGN_IN_ERROR_HTML("GitHub didn't return a verified primary email. Add and verify a primary email at github.com/settings/emails, or sign in with the email link below."),
      400,
      NO_STORE,
    );
  }

  let resolved: ResolvedIdentity;
  try {
    resolved = await resolveIdentity(env.DB, "github", String(ghUser.id), primaryEmail, now);
  } catch (err) {
    console.error("resolve_identity_failed", err);
    return htmlResponse(SIGN_IN_ERROR_HTML("Sign-in failed. Please try again."), 503, NO_STORE);
  }

  const sessionId = crypto.randomUUID();
  const sessionExpires = now + SESSION_TTL_MS;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(sessionId, resolved.user_id, now, sessionExpires),
    env.DB.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").bind(now, resolved.user_id),
  ]);

  // If the original /start carried a user_code, attach the new session
  // to that device_codes row. Atomic UPDATE — if 0 rows changed, the
  // device_codes TTL ran out during the OAuth round-trip.
  let attachedDeviceCode = false;
  if (stateRow.user_code) {
    const dc = await env.DB
      .prepare("SELECT device_code FROM device_codes WHERE user_code = ?")
      .bind(stateRow.user_code)
      .first<{ device_code: string }>();
    if (dc) {
      const attachRes = await env.DB
        .prepare(
          "UPDATE device_codes SET session_id = ? WHERE device_code = ? AND session_id IS NULL AND expires_at > ?",
        )
        .bind(sessionId, dc.device_code, now)
        .run();
      attachedDeviceCode = (attachRes.meta?.changes ?? 0) === 1;
      if (!attachedDeviceCode) {
        // Race: device_codes TTL'd during the OAuth round-trip. Session
        // is valid for the browser cookie; the local app missed the
        // window. Surface the error rather than silent split-brain.
        const cookie = sessionCookie(sessionId, url.host);
        return htmlResponse(SIGN_IN_EXPIRED_HTML(true), 400, {
          "set-cookie": cookie,
          ...NO_STORE,
        });
      }
    } else {
      // user_code disappeared (TTL'd and gc'd) — same UX outcome.
      const cookie = sessionCookie(sessionId, url.host);
      return htmlResponse(SIGN_IN_EXPIRED_HTML(true), 400, {
        "set-cookie": cookie,
        ...NO_STORE,
      });
    }
  }

  const cookie = sessionCookie(sessionId, url.host);

  // Browser-only: 302 to /auth/welcome (matches handleVerify shape).
  // Local-handoff: render WELCOME_HTML directly with the "you can close
  // this window" copy so the user doesn't see a flash of /auth/welcome.
  if (attachedDeviceCode) {
    return htmlResponse(WELCOME_HTML(resolved.email_for_session, true), 200, {
      "set-cookie": cookie,
      ...NO_STORE,
    });
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: "/auth/welcome",
      "set-cookie": cookie,
      ...NO_STORE,
    },
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/auth/sign-in" && req.method === "GET") {
        // /auth/sign-in carries an optional ?d=<user_code> for the device
        // flow; no-store stops browsers and intermediaries from caching a
        // URL that contains a login-related code.
        const userCode = url.searchParams.get("d");
        // Mutual exclusion: if ?d= is present, it wins (device flow is its own
        // destination); ?return= is dropped.
        const returnPath = userCode ? null : validateReturnPath(url.searchParams.get("return"));
        return htmlResponse(SIGN_IN_HTML(userCode, returnPath), 200, NO_STORE);
      }
      if (url.pathname === "/auth/magic-link" && req.method === "POST") {
        return await handleMagicLink(req, env, ctx, url);
      }
      if (url.pathname === "/auth/verify" && req.method === "GET") {
        return await handleVerify(env, url);
      }
      if (url.pathname === "/auth/welcome" && req.method === "GET") {
        return await handleWelcome(req, env, url.host);
      }
      if (url.pathname === "/auth/whoami" && req.method === "GET") {
        return await handleWhoami(req, env, url.host);
      }
      if (url.pathname === "/auth/github/start" && req.method === "GET") {
        return await handleGithubStart(req, env, url);
      }
      if (url.pathname === "/auth/github/callback" && req.method === "GET") {
        return await handleGithubCallback(req, env, url);
      }
      if (url.pathname === "/auth/device-init" && req.method === "POST") {
        return await handleDeviceInit(req, env);
      }
      const deviceMatch = url.pathname.match(/^\/auth\/device\/([^/]+)$/);
      if (deviceMatch && req.method === "GET") {
        return await handleDevicePoll(env, decodeURIComponent(deviceMatch[1]));
      }
      if (url.pathname === "/auth/sign-out" && req.method === "POST") {
        return await handleSignOut(req, env, url.host);
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      // Single-point catch so a transient D1 error or thrown exception
      // returns a structured 503 instead of an unstructured 500. The
      // most common failure mode at this layer is D1 being unreachable;
      // service_unavailable is the honest shape.
      console.error("worker_unhandled", url.pathname, err);
      return json({ error: "service_unavailable" }, 503);
    }
  },
};
