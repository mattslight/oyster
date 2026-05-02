// Oyster auth worker — Cloudflare-native magic-link auth and (in PR 3)
// device-flow bridge to the local server at localhost:4444. See
// docs/plans/auth.md for the full design.
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
}

// Magic-link tokens are always 43 chars (32 bytes base64url, no padding).
// Cap the input well above that to keep `?t=<huge>` from wasting CPU on
// the sha256, but loose enough to tolerate URL-encoding wraps and future
// token-length changes.
const MAX_TOKEN_LEN = 100;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
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

const SIGN_IN_HTML = (userCode: string | null) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to Oyster</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 28rem; margin: 6rem auto; padding: 0 1.5rem; line-height: 1.5; }
  h1 { font-size: 1.5rem; margin: 0 0 1.5rem; }
  form { display: flex; flex-direction: column; gap: 0.75rem; }
  label { font-size: 0.85rem; opacity: 0.7; }
  input[type=email] { padding: 0.6rem 0.75rem; font-size: 1rem; border: 1px solid #888; border-radius: 0.4rem; background: transparent; color: inherit; }
  button { padding: 0.6rem 0.75rem; font-size: 1rem; font-weight: 600; border: 0; border-radius: 0.4rem; background: #6750a4; color: #fff; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  #status { margin-top: 1rem; font-size: 0.9rem; }
  .ok { color: #2e7d32; }
  .err { color: #c62828; }
</style>
</head><body>
<h1>Sign in to Oyster</h1>
<form id="f">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required autofocus autocomplete="email">
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
  const btn = f.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await fetch('/auth/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, user_code: userCode }),
    });
    if (res.ok) {
      f.style.display = 'none';
      s.hidden = false;
      s.className = 'ok';
      s.textContent = 'Check your inbox for a sign-in link. The link expires in 15 minutes.';
    } else {
      s.hidden = false;
      s.className = 'err';
      s.textContent = 'Could not send the link. Check the email and try again.';
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

  // Resolve user_code → device_code if present. Unknown user_codes are
  // ignored silently (degrades gracefully to a non-device login).
  let deviceCode: string | null = null;
  if (userCode) {
    const dc = await env.DB
      .prepare("SELECT device_code FROM device_codes WHERE user_code = ? AND expires_at > ? AND session_id IS NULL")
      .bind(userCode, now)
      .first<{ device_code: string }>();
    deviceCode = dc?.device_code ?? null;
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

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/auth/sign-in" && req.method === "GET") {
        // /auth/sign-in carries an optional ?d=<user_code> for the device
        // flow; no-store stops browsers and intermediaries from caching a
        // URL that contains a login-related code.
        return htmlResponse(SIGN_IN_HTML(url.searchParams.get("d")), 200, NO_STORE);
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
