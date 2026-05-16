// Oyster Rocket Ship leaderboard worker
//
// GET  /api/leaderboard            → { list: [{ initials, score, created_at }, ...] }
// GET  /api/leaderboard/start      → { token, expires_at }
//                                    Token is required to submit a score. It's an
//                                    HMAC-signed (exp + ip_hash) payload bound to
//                                    the requesting IP. TTL 15 min.
// POST /api/leaderboard            → { ok: true, list: [...] }
//                                    body: { initials: string (1–3 chars), score: int > 0, token: string }
//
// Defences (in order of cheapness):
//   1. Score cap (MAX_SCORE) — anything beyond a realistic hand-flown game is rejected.
//   2. Origin allowlist on mutating verbs.
//   3. Per-IP rate limit binding (1 submission per 60s).
//   4. HMAC-signed proof-of-play token — must be minted recently from the same IP.
//   5. Soft cap (RETAIN_N) on the table so spam can't bloat D1.
//
// None of this is cryptographic gameplay-verification — a determined attacker who
// mints a token and POSTs a score within the same minute can still cheat once per
// minute. The combination just makes scripted abuse expensive enough not to bother
// for an easter-egg leaderboard.

export interface Env {
  DB: D1Database;
  HMAC_SECRET: string; // set via `wrangler secret put HMAC_SECRET`
}

const ALLOWED_ORIGINS = new Set(["https://oyster.to", "https://www.oyster.to"]);
const INITIALS_RE = /^[A-Z0-9.\-]{1,3}$/;
const MAX_SCORE = 999;
const TOP_N = 10;
const RETAIN_N = 100;
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour — enough for a long grinding session toward 999
const RATE_LIMIT_MS = 60 * 1000;     // 1 submission per minute per IP

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:");
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(new Uint8Array(sig));
}
async function hmacVerify(secret: string, data: string, sig: string): Promise<boolean> {
  try {
    const key = await importHmacKey(secret);
    return crypto.subtle.verify("HMAC", key, b64urlDecode(sig), new TextEncoder().encode(data));
  } catch { return false; }
}

// IP hash bound to a per-deploy secret — never store raw IPs, but stably
// identify the same client across token-mint + token-redeem.
async function hashIp(ip: string, secret: string): Promise<string> {
  const data = new TextEncoder().encode("ip\x00" + secret + "\x00" + ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest)).slice(0, 32);
}

interface TokenPayload {
  exp: number;
  ip: string; // hashed
}
async function mintToken(secret: string, ipHash: string): Promise<{ token: string; expires_at: number }> {
  const payload: TokenPayload = { exp: Date.now() + TOKEN_TTL_MS, ip: ipHash };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(secret, body);
  return { token: `${body}.${sig}`, expires_at: payload.exp };
}
async function verifyToken(secret: string, token: string, currentIpHash: string): Promise<boolean> {
  if (typeof token !== "string" || !token.includes(".")) return false;
  const [body, sig] = token.split(".");
  if (!body || !sig) return false;
  const ok = await hmacVerify(secret, body, sig);
  if (!ok) return false;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch { return false; }
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) return false;
  if (payload.ip !== currentIpHash) return false;
  return true;
}

async function topN(db: D1Database, n: number) {
  const { results } = await db
    .prepare(
      "SELECT initials, score, created_at FROM scores ORDER BY score DESC, created_at ASC LIMIT ?"
    )
    .bind(n)
    .all<{ initials: string; score: number; created_at: number }>();
  return results ?? [];
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const isStart = url.pathname === "/api/leaderboard/start";
    const isLeaderboard = url.pathname === "/api/leaderboard";
    if (!isStart && !isLeaderboard) return new Response("Not found", { status: 404 });

    const origin = req.headers.get("origin");
    const isMutation = req.method === "POST" || req.method === "OPTIONS";
    if (isMutation || isStart) {
      if (!isAllowedOrigin(origin)) return new Response("Forbidden", { status: 403 });
    } else if (origin !== null && !isAllowedOrigin(origin)) {
      return new Response("Forbidden", { status: 403 });
    }
    const corsHeaders: Record<string, string> = origin
      ? { "access-control-allow-origin": origin, "vary": "origin" }
      : {};

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "86400",
        },
      });
    }

    if (!env.HMAC_SECRET) {
      console.error("HMAC_SECRET not configured");
      return json({ error: "service_unavailable" }, 503, corsHeaders);
    }

    const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
    const ipHash = await hashIp(ip, env.HMAC_SECRET);

    if (isStart) {
      if (req.method !== "GET") {
        return new Response("Method not allowed", { status: 405, headers: corsHeaders });
      }
      const { token, expires_at } = await mintToken(env.HMAC_SECRET, ipHash);
      return json({ token, expires_at }, 200, corsHeaders);
    }

    // /api/leaderboard
    if (req.method === "GET") {
      try {
        const list = await topN(env.DB, TOP_N);
        return json({ list }, 200, corsHeaders);
      } catch (err) {
        console.error("d1_select_failed", err);
        return json({ error: "storage_failed" }, 500, corsHeaders);
      }
    }

    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    // Per-IP rate limit — D1-backed, 1 POST per RATE_LIMIT_MS per IP.
    // Atomic CAS-style upsert so a flurry of concurrent requests can't slip
    // through: only update the row when the previous timestamp is outside
    // the window. `meta.changes === 0` means we were inside the window.
    try {
      const now = Date.now();
      const since = now - RATE_LIMIT_MS;
      const res = await env.DB
        .prepare(
          `INSERT INTO rate_limit (key, last_at) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET last_at = excluded.last_at
           WHERE rate_limit.last_at < ?`
        )
        .bind(ipHash, now, since)
        .run();
      if ((res.meta?.changes ?? 0) === 0) {
        return json({ error: "rate_limited" }, 429, corsHeaders);
      }
    } catch (err) {
      console.error("rate_limit_failed", err);
      // Fail closed — better to reject than silently let abuse through.
      return json({ error: "rate_limit_unavailable" }, 503, corsHeaders);
    }

    let payload: { initials?: unknown; score?: unknown; token?: unknown };
    try {
      payload = await req.json();
    } catch {
      return json({ error: "invalid_json" }, 400, corsHeaders);
    }

    const initials =
      typeof payload.initials === "string" ? payload.initials.trim().toUpperCase() : "";
    if (!INITIALS_RE.test(initials)) {
      return json({ error: "invalid_initials" }, 400, corsHeaders);
    }
    const score =
      typeof payload.score === "number" && Number.isFinite(payload.score)
        ? Math.floor(payload.score)
        : NaN;
    if (!Number.isFinite(score) || score <= 0 || score > MAX_SCORE) {
      return json({ error: "invalid_score" }, 400, corsHeaders);
    }
    const tokenOk = typeof payload.token === "string"
      ? await verifyToken(env.HMAC_SECRET, payload.token, ipHash)
      : false;
    if (!tokenOk) {
      return json({ error: "invalid_token" }, 401, corsHeaders);
    }

    const created_at = Date.now();
    const ip_country = req.headers.get("cf-ipcountry") ?? null;
    const user_agent = (req.headers.get("user-agent") ?? "").slice(0, 256);

    try {
      await env.DB
        .prepare(
          "INSERT INTO scores (initials, score, created_at, ip_country, user_agent) VALUES (?, ?, ?, ?, ?)"
        )
        .bind(initials, score, created_at, ip_country, user_agent)
        .run();
      // Prune rows beyond RETAIN_N so the table stays bounded under spam.
      await env.DB
        .prepare(
          `DELETE FROM scores WHERE id NOT IN (
             SELECT id FROM scores ORDER BY score DESC, created_at ASC LIMIT ?
           )`
        )
        .bind(RETAIN_N)
        .run();
      const list = await topN(env.DB, TOP_N);
      return json({ ok: true, list }, 200, corsHeaders);
    } catch (err) {
      console.error("d1_insert_failed", err);
      return json({ error: "storage_failed" }, 500, corsHeaders);
    }
  },
};
