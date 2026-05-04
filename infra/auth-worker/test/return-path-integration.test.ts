// Integration tests for return_path threading through auth-worker handlers.
// Uses @cloudflare/vitest-pool-workers (miniflare) for a real D1 + Worker
// runtime; no external HTTP calls are made (RESEND_API_KEY is unset so
// sendMagicLink no-ops, and /auth/github/callback is not tested here — see
// the gap note at the bottom of this file).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import { sha256Hex } from "../src/worker";
import { applySchema, seedUserCode } from "./fixtures/seed";

// MAGIC_LINK_LIMIT is a Cloudflare rate-limit binding; miniflare doesn't
// auto-mock it. Inject a stub that always succeeds so handler logic is
// reachable in tests.
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (env as any).MAGIC_LINK_LIMIT = { limit: async () => ({ success: true }) };
});

beforeEach(async () => {
  await applySchema();
});

// ─── helpers ────────────────────────────────────────────────────────────────

function makeReq(method: string, path: string, opts: {
  body?: unknown;
  headers?: Record<string, string>;
} = {}): Request {
  const headers = new Headers(opts.headers ?? {});
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(opts.body);
  }
  return new Request(`https://oyster.to${path}`, { method, headers, body });
}

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// ─── POST /auth/magic-link ──────────────────────────────────────────────────

describe("POST /auth/magic-link — return_path threading", () => {
  it("valid return_path is stored on the magic_link_tokens row", async () => {
    const res = await call(makeReq("POST", "/auth/magic-link", {
      body: { email: "test@example.com", return_path: "/p/abc123" },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });

    const row = await env.DB
      .prepare("SELECT return_path FROM magic_link_tokens LIMIT 1")
      .first<{ return_path: string | null }>();
    expect(row).not.toBeNull();
    expect(row!.return_path).toBe("/p/abc123");
  });

  it("invalid return_path (absolute URL) is silently dropped — row gets NULL", async () => {
    const res = await call(makeReq("POST", "/auth/magic-link", {
      body: { email: "test2@example.com", return_path: "https://attacker.com/steal" },
    }));
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare("SELECT return_path FROM magic_link_tokens LIMIT 1")
      .first<{ return_path: string | null }>();
    expect(row).not.toBeNull();
    expect(row!.return_path).toBeNull();
  });

  it("user_code AND return_path → mutual exclusion: row gets NULL (device flow wins)", async () => {
    const userCode = "ABCD-1234";
    await seedUserCode({ userCode });

    const res = await call(makeReq("POST", "/auth/magic-link", {
      body: { email: "test3@example.com", user_code: userCode, return_path: "/p/abc123" },
    }));
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare("SELECT return_path FROM magic_link_tokens LIMIT 1")
      .first<{ return_path: string | null }>();
    expect(row).not.toBeNull();
    expect(row!.return_path).toBeNull();
  });
});

// ─── GET /auth/verify ───────────────────────────────────────────────────────

describe("GET /auth/verify — return_path redirect", () => {
  async function seedToken(email: string, returnPath: string | null): Promise<string> {
    const rawToken = "test-raw-token-" + Math.random().toString(36).slice(2);
    const tokenHash = await sha256Hex(rawToken);
    const now = Date.now();
    const expiresAt = now + 15 * 60 * 1000;

    // Ensure the user exists.
    const userId = crypto.randomUUID();
    await env.DB
      .prepare("INSERT OR IGNORE INTO users (id, email, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
      .bind(userId, email, now, now)
      .run();
    const user = await env.DB
      .prepare("SELECT id FROM users WHERE email = ?")
      .bind(email)
      .first<{ id: string }>();

    await env.DB
      .prepare(
        "INSERT INTO magic_link_tokens (token_hash, user_id, device_code, expires_at, return_path) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(tokenHash, user!.id, null, expiresAt, returnPath)
      .run();

    return rawToken;
  }

  it("row with return_path → 302 to that path, with session cookie", async () => {
    const rawToken = await seedToken("verify1@example.com", "/p/abc123");
    const res = await call(makeReq("GET", `/auth/verify?t=${encodeURIComponent(rawToken)}`));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/p/abc123");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("oyster_session=");
  });

  it("row WITHOUT return_path → 302 to /auth/welcome", async () => {
    const rawToken = await seedToken("verify2@example.com", null);
    const res = await call(makeReq("GET", `/auth/verify?t=${encodeURIComponent(rawToken)}`));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/welcome");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("oyster_session=");
  });
});

// ─── GET /auth/github/start ─────────────────────────────────────────────────

describe("GET /auth/github/start — return_path threading", () => {
  it("?return=/p/abc123 → oauth_states row has return_path = '/p/abc123'", async () => {
    const res = await call(makeReq("GET", "/auth/github/start?return=/p/abc123"));

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("github.com/login/oauth/authorize");

    // Extract the state param from the redirect URL.
    const redirectUrl = new URL(location);
    const state = redirectUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    const row = await env.DB
      .prepare("SELECT return_path FROM oauth_states WHERE state = ?")
      .bind(state)
      .first<{ return_path: string | null }>();
    expect(row).not.toBeNull();
    expect(row!.return_path).toBe("/p/abc123");
  });

  it("?return=... AND ?d=USERCODE → mutual exclusion: oauth_states row gets NULL", async () => {
    const userCode = "WXYZ-5678";
    await seedUserCode({ userCode });

    const res = await call(
      makeReq("GET", `/auth/github/start?return=/p/abc123&d=${encodeURIComponent(userCode)}`)
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("github.com/login/oauth/authorize");

    const redirectUrl = new URL(location);
    const state = redirectUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    const row = await env.DB
      .prepare("SELECT return_path FROM oauth_states WHERE state = ?")
      .bind(state)
      .first<{ return_path: string | null }>();
    expect(row).not.toBeNull();
    expect(row!.return_path).toBeNull();
  });
});

// ─── GET /auth/sign-in — HTML round-trip ────────────────────────────────────

describe("GET /auth/sign-in — return_path HTML round-trip", () => {
  it("?return=/p/abc123 → HTML form contains value='/p/abc123' in hidden input", async () => {
    const res = await call(makeReq("GET", "/auth/sign-in?return=/p/abc123"));

    expect(res.status).toBe(200);
    const body = await res.text();
    // The hidden return_path input should carry the value through.
    expect(body).toContain('value="/p/abc123"');
  });
});

// ─── Gap note ────────────────────────────────────────────────────────────────
// GET /auth/github/callback is NOT tested here.
// The callback handler requires mocking GitHub's token-exchange
// (https://github.com/login/oauth/access_token) and user-info
// (https://api.github.com/user + /user/emails) HTTP endpoints. Miniflare
// doesn't intercept outbound fetch by default; adding fetch-mock
// infrastructure is deferred. The start-side tests above confirm that
// return_path is threaded into oauth_states correctly; the callback side
// reads it back via the same RETURNING clause pattern (already unit-tested
// indirectly through handleVerify's analogous consume flow).
