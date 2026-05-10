import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";
import { applySchema } from "./fixtures/seed.js";

async function makeProSession(suffix = crypto.randomUUID()): Promise<{ token: string; userId: string }> {
  const userId = `u-pro-${suffix}`;
  const token  = `tok-pro-${suffix}`;
  await env.DB.prepare(`INSERT INTO users (id, email, tier, created_at) VALUES (?, ?, 'pro', ?)`)
    .bind(userId, `pro-${suffix}@example.com`, Date.now()).run();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL)`,
  ).bind(token, userId, Date.now(), Date.now() + 86400_000).run();
  return { token, userId };
}

async function makeFreeSession(suffix = crypto.randomUUID()): Promise<{ token: string; userId: string }> {
  const userId = `u-free-${suffix}`;
  const token  = `tok-free-${suffix}`;
  await env.DB.prepare(`INSERT INTO users (id, email, tier, created_at) VALUES (?, ?, 'free', ?)`)
    .bind(userId, `free-${suffix}@example.com`, Date.now()).run();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL)`,
  ).bind(token, userId, Date.now(), Date.now() + 86400_000).run();
  return { token, userId };
}

function signedFetch(path: string, init: RequestInit, token: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", `oyster_session=${token}`);
  return SELF.fetch(`https://example.com${path}`, { ...init, headers });
}

function sampleSession(id: string, syncDirtyAt: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    device_id: "dev-mac-01",
    agent: "claude-code",
    title: "Test session",
    state: "done",
    cwd: "/Users/test/proj",
    model: "claude-sonnet-4-6",
    started_at: "2026-05-10T10:00:00Z",
    ended_at: "2026-05-10T10:30:00Z",
    last_event_at: "2026-05-10T10:30:00Z",
    sync_dirty_at: syncDirtyAt,
    ...overrides,
  };
}

describe("POST /api/sessions/metadata", () => {
  beforeAll(async () => { await applySchema(); });

  it("rejects unsigned requests with 401", async () => {
    const res = await SELF.fetch("https://example.com/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects free-tier users with 403", async () => {
    const { token } = await makeFreeSession();
    const res = await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [] }),
    }, token);
    expect(res.status).toBe(403);
  });

  it("accepts a valid session and stores it scoped to owner", async () => {
    const { token, userId } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    const res = await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [sampleSession(sid, 1000)] }),
    }, token);
    expect(res.status).toBe(200);
    const body = await res.json() as { accepted: string[]; rejected: string[] };
    expect(body.accepted).toEqual([sid]);
    expect(body.rejected).toEqual([]);

    const row = await env.DB.prepare(
      `SELECT owner_id, agent, state, updated_at FROM synced_session_metadata
        WHERE owner_id = ? AND session_id = ?`,
    ).bind(userId, sid).first();
    expect(row).toMatchObject({ owner_id: userId, agent: "claude-code", state: "done", updated_at: 1000 });
  });

  it("LWW: a newer sync_dirty_at wins; an older one is dropped", async () => {
    const { token, userId } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    // First push at t=2000 with title "v1"
    await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [sampleSession(sid, 2000, { title: "v1" })] }),
    }, token);
    // Newer push at t=3000 with title "v2" — should win
    await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [sampleSession(sid, 3000, { title: "v2" })] }),
    }, token);
    // Older push at t=1000 with title "ancient" — should lose
    await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [sampleSession(sid, 1000, { title: "ancient" })] }),
    }, token);

    const row = await env.DB.prepare(
      `SELECT title, updated_at FROM synced_session_metadata WHERE owner_id = ? AND session_id = ?`,
    ).bind(userId, sid).first<{ title: string; updated_at: number }>();
    expect(row?.title).toBe("v2");
    expect(row?.updated_at).toBe(3000);
  });

  it("rejects malformed sessions but still accepts the valid ones in the same batch", async () => {
    const { token, userId } = await makeProSession();
    const goodId = `s-${crypto.randomUUID()}`;
    const res = await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessions: [
          sampleSession(goodId, 1000),
          { id: "bad", agent: "claude-code" },  // missing required fields
          { /* no id */ agent: "claude-code", state: "done", started_at: "x", last_event_at: "y", sync_dirty_at: 1 },
        ],
      }),
    }, token);
    expect(res.status).toBe(200);
    const body = await res.json() as { accepted: string[]; rejected: string[] };
    expect(body.accepted).toEqual([goodId]);
    expect(body.rejected).toEqual(["bad", "<malformed>"]);

    const count = await env.DB.prepare(
      `SELECT COUNT(*) as n FROM synced_session_metadata WHERE owner_id = ?`,
    ).bind(userId).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

describe("GET /api/sessions/metadata", () => {
  beforeAll(async () => { await applySchema(); });

  it("returns only the caller's sessions", async () => {
    const a = await makeProSession();
    const b = await makeProSession();
    const sidA = `s-${crypto.randomUUID()}`;
    const sidB = `s-${crypto.randomUUID()}`;
    await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [sampleSession(sidA, 1000)] }),
    }, a.token);
    await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [sampleSession(sidB, 1000)] }),
    }, b.token);

    const res = await signedFetch("/api/sessions/metadata", { method: "GET" }, a.token);
    expect(res.status).toBe(200);
    const body = await res.json() as { sessions: Array<{ session_id: string }> };
    const ids = body.sessions.map((s) => s.session_id);
    expect(ids).toContain(sidA);
    expect(ids).not.toContain(sidB);
  });
});

describe("PUT /api/sessions/bytes/:id + GET round-trip", () => {
  beforeAll(async () => { await applySchema(); });

  it("encrypts on PUT, decrypts on GET, returns identical plaintext", async () => {
    const { token } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    // Metadata has to exist first (the PUT does an owner check against it).
    await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [sampleSession(sid, 1000)] }),
    }, token);

    const plaintext = new TextEncoder().encode(
      `{"type":"user","content":"hello"}\n{"type":"assistant","content":"hi"}\n`,
    );
    const putRes = await signedFetch(`/api/sessions/bytes/${sid}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: plaintext,
    }, token);
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json() as { ok: boolean; key: string; plaintextSize: number; ciphertextSize: number };
    expect(putBody.ok).toBe(true);
    expect(putBody.plaintextSize).toBe(plaintext.byteLength);
    // Ciphertext = IV (12) + plaintext + AES-GCM tag (16)
    expect(putBody.ciphertextSize).toBe(plaintext.byteLength + 12 + 16);

    const getRes = await signedFetch(`/api/sessions/bytes/${sid}`, { method: "GET" }, token);
    expect(getRes.status).toBe(200);
    const got = new Uint8Array(await getRes.arrayBuffer());
    expect(got).toEqual(plaintext);
  });

  it("R2 object stores ciphertext, not plaintext", async () => {
    const { token, userId } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [sampleSession(sid, 1000)] }),
    }, token);

    const plaintext = new TextEncoder().encode("PLAINTEXT_MARKER_DO_NOT_LEAK");
    await signedFetch(`/api/sessions/bytes/${sid}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: plaintext,
    }, token);

    const obj = await env.SESSIONS_BUCKET.get(`sessions/${userId}/${sid}.jsonl`);
    expect(obj).not.toBeNull();
    const stored = new Uint8Array(await obj!.arrayBuffer());
    const decoded = new TextDecoder().decode(stored);
    expect(decoded).not.toContain("PLAINTEXT_MARKER_DO_NOT_LEAK");
  });

  it("returns 404 when uploading to a session that doesn't belong to the caller", async () => {
    const owner = await makeProSession();
    const intruder = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    // Owner registers metadata
    await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [sampleSession(sid, 1000)] }),
    }, owner.token);
    // Intruder tries to upload bytes to that session id
    const res = await signedFetch(`/api/sessions/bytes/${sid}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new TextEncoder().encode("nope"),
    }, intruder.token);
    expect(res.status).toBe(404);
  });

  it("returns 404 when GETting bytes that haven't been uploaded", async () => {
    const { token } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [sampleSession(sid, 1000)] }),
    }, token);

    const res = await signedFetch(`/api/sessions/bytes/${sid}`, { method: "GET" }, token);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("bytes_not_uploaded");
  });
});
