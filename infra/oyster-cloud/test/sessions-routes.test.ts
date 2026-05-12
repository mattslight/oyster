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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i]!.toString(16).padStart(2, "0");
  return hex;
}

async function putChunk(
  token: string,
  sessionId: string,
  chunkNumber: number,
  bytes: Uint8Array,
  startOffset: number,
  generation: number,
  deviceId?: string,
): Promise<{ res: Response; sha: string }> {
  const sha = await sha256Hex(bytes);
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "x-chunk-start-offset": String(startOffset),
    "x-chunk-end-offset": String(startOffset + bytes.byteLength),
    "x-plaintext-sha256": sha,
    "x-bytes-generation": String(generation),
  };
  if (deviceId) headers["x-bytes-device-id"] = deviceId;
  const res = await signedFetch(
    `/api/sessions/bytes/${sessionId}/chunk/${chunkNumber}`,
    { method: "PUT", headers, body: bytes },
    token,
  );
  return { res, sha };
}

async function registerSession(token: string, sid: string) {
  await signedFetch("/api/sessions/metadata", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessions: [sampleSession(sid, 1000)] }),
  }, token);
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
      `SELECT owner_id, agent, state, updated_at, bytes_generation
         FROM synced_session_metadata WHERE owner_id = ? AND session_id = ?`,
    ).bind(userId, sid).first();
    expect(row).toMatchObject({
      owner_id: userId, agent: "claude-code", state: "done",
      updated_at: 1000, bytes_generation: 0,
    });
  });

  it("LWW: a newer sync_dirty_at wins; an older one is dropped", async () => {
    const { token, userId } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [sampleSession(sid, 2000, { title: "v1" })] }),
    }, token);
    await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [sampleSession(sid, 3000, { title: "v2" })] }),
    }, token);
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

  it("rejects malformed sessions but accepts valid ones in the same batch", async () => {
    const { token, userId } = await makeProSession();
    const goodId = `s-${crypto.randomUUID()}`;
    const res = await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessions: [
          sampleSession(goodId, 1000),
          { id: "bad", agent: "claude-code" },
          { agent: "claude-code", state: "done", started_at: "x", last_event_at: "y", sync_dirty_at: 1 },
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

  it("rejects nullable fields with non-string types instead of crashing D1.bind", async () => {
    const { token, userId } = await makeProSession();
    const goodId = `s-${crypto.randomUUID()}`;
    const badTypeId = `s-${crypto.randomUUID()}`;
    const res = await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessions: [
          sampleSession(goodId, 1000),
          sampleSession(badTypeId, 1000, { title: 12345 }),
        ],
      }),
    }, token);
    expect(res.status).toBe(200);
    const body = await res.json() as { accepted: string[]; rejected: string[] };
    expect(body.accepted).toEqual([goodId]);
    expect(body.rejected).toEqual([badTypeId]);
    const count = await env.DB.prepare(
      `SELECT COUNT(*) as n FROM synced_session_metadata WHERE owner_id = ?`,
    ).bind(userId).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("accepts a session with nullable fields missing entirely (undefined → null at bind)", async () => {
    const { token, userId } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    const res = await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessions: [{
          id: sid,
          agent: "claude-code",
          state: "done",
          started_at: "2026-05-11T10:00:00Z",
          last_event_at: "2026-05-11T10:30:00Z",
          sync_dirty_at: 1000,
          // title, cwd, model, ended_at, device_id all omitted
        }],
      }),
    }, token);
    expect(res.status).toBe(200);
    const body = await res.json() as { accepted: string[]; rejected: string[] };
    expect(body.accepted).toEqual([sid]);
    expect(body.rejected).toEqual([]);
    // The row landed with null for the unspecified columns.
    const row = await env.DB.prepare(
      `SELECT title, cwd, model, ended_at, device_id FROM synced_session_metadata
        WHERE owner_id = ? AND session_id = ?`,
    ).bind(userId, sid).first();
    expect(row).toMatchObject({ title: null, cwd: null, model: null, ended_at: null, device_id: null });
  });

  it("rejects negative sync_dirty_at", async () => {
    const { token } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    const res = await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [sampleSession(sid, -1)] }),
    }, token);
    expect(res.status).toBe(200);
    const body = await res.json() as { accepted: string[]; rejected: string[] };
    expect(body.accepted).toEqual([]);
    expect(body.rejected).toEqual([sid]);
  });
});

describe("GET /api/sessions/metadata", () => {
  beforeAll(async () => { await applySchema(); });

  it("returns only the caller's sessions with has_bytes=false when no chunks", async () => {
    const a = await makeProSession();
    const b = await makeProSession();
    const sidA = `s-${crypto.randomUUID()}`;
    const sidB = `s-${crypto.randomUUID()}`;
    await registerSession(a.token, sidA);
    await registerSession(b.token, sidB);

    const res = await signedFetch("/api/sessions/metadata", { method: "GET" }, a.token);
    expect(res.status).toBe(200);
    const body = await res.json() as { sessions: Array<{ session_id: string; has_bytes: boolean }> };
    const ids = body.sessions.map((s) => s.session_id);
    expect(ids).toContain(sidA);
    expect(ids).not.toContain(sidB);
    const ours = body.sessions.find((s) => s.session_id === sidA);
    expect(ours?.has_bytes).toBe(false);
  });
});

describe("PUT/GET /api/sessions/bytes/:id/chunk/:n (chunked-delta)", () => {
  beforeAll(async () => { await applySchema(); });

  it("upload chunks 1 + 2 + 3, fetch manifest + each chunk individually, concatenate matches local", async () => {
    const { token, userId } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    await registerSession(token, sid);

    const c1 = new TextEncoder().encode("{\"role\":\"user\",\"content\":\"hello\"}\n");
    const c2 = new TextEncoder().encode("{\"role\":\"assistant\",\"content\":\"hi\"}\n");
    const c3 = new TextEncoder().encode("{\"role\":\"user\",\"content\":\"bye\"}\n");

    expect((await putChunk(token, sid, 1, c1, 0, 0)).res.status).toBe(200);
    expect((await putChunk(token, sid, 2, c2, c1.byteLength, 0)).res.status).toBe(200);
    expect((await putChunk(token, sid, 3, c3, c1.byteLength + c2.byteLength, 0)).res.status).toBe(200);

    // Manifest
    const manifestRes = await signedFetch(`/api/sessions/bytes/${sid}/manifest`, { method: "GET" }, token);
    expect(manifestRes.status).toBe(200);
    const manifest = await manifestRes.json() as {
      bytes_generation: number;
      total_size: number;
      chunks: Array<{ chunk_number: number; start_offset: number; end_offset: number; byte_count: number; plaintext_sha256: string }>;
    };
    expect(manifest.bytes_generation).toBe(0);
    expect(manifest.total_size).toBe(c1.byteLength + c2.byteLength + c3.byteLength);
    expect(manifest.chunks.map((c) => c.chunk_number)).toEqual([1, 2, 3]);

    // Per-chunk download + concatenate
    const local = new Uint8Array(manifest.total_size);
    for (const meta of manifest.chunks) {
      const r = await signedFetch(`/api/sessions/bytes/${sid}/chunk/${meta.chunk_number}`, { method: "GET" }, token);
      expect(r.status).toBe(200);
      const bytes = new Uint8Array(await r.arrayBuffer());
      expect(bytes.byteLength).toBe(meta.byte_count);
      expect(await sha256Hex(bytes)).toBe(meta.plaintext_sha256);
      local.set(bytes, meta.start_offset);
    }

    const expected = new Uint8Array(c1.byteLength + c2.byteLength + c3.byteLength);
    expected.set(c1, 0); expected.set(c2, c1.byteLength); expected.set(c3, c1.byteLength + c2.byteLength);
    expect(local).toEqual(expected);

    // metadata.has_bytes should now be true
    const listRes = await signedFetch("/api/sessions/metadata", { method: "GET" }, token);
    const list = await listRes.json() as { sessions: Array<{ session_id: string; has_bytes: boolean }> };
    expect(list.sessions.find((s) => s.session_id === sid)?.has_bytes).toBe(true);
    void userId;  // silence unused
  });

  it("idempotent re-PUT of identical chunk → 200 idempotent:true, no duplicate row", async () => {
    const { token, userId } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    await registerSession(token, sid);

    const c1 = new TextEncoder().encode("identical bytes");
    expect((await putChunk(token, sid, 1, c1, 0, 0)).res.status).toBe(200);
    const second = await putChunk(token, sid, 1, c1, 0, 0);
    expect(second.res.status).toBe(200);
    const body = await second.res.json() as { idempotent?: boolean };
    expect(body.idempotent).toBe(true);

    const count = await env.DB.prepare(
      `SELECT COUNT(*) as n FROM synced_session_chunks WHERE owner_id = ? AND session_id = ?`,
    ).bind(userId, sid).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("conflicting re-PUT (same chunk_number, different hash) → 409 chunk_conflict", async () => {
    const { token } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    await registerSession(token, sid);

    const c1 = new TextEncoder().encode("first content");
    expect((await putChunk(token, sid, 1, c1, 0, 0)).res.status).toBe(200);

    const c1Alt = new TextEncoder().encode("DIFFERENT content");  // different length + bytes
    const conflict = await putChunk(token, sid, 1, c1Alt, 0, 0);
    expect(conflict.res.status).toBe(409);
    const body = await conflict.res.json() as { error: string };
    expect(body.error).toBe("chunk_conflict");
  });

  it("non-contiguous PUT (start_offset doesn't match previous end_offset) → 409 non_contiguous_start", async () => {
    const { token } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    await registerSession(token, sid);

    const c1 = new TextEncoder().encode("AAAA");
    expect((await putChunk(token, sid, 1, c1, 0, 0)).res.status).toBe(200);

    // Chunk 2 should start at offset 4, but we say 99.
    const c2 = new TextEncoder().encode("BBBB");
    const res = await putChunk(token, sid, 2, c2, 99, 0);
    expect(res.res.status).toBe(409);
    const body = await res.res.json() as { error: string };
    expect(body.error).toBe("non_contiguous_start");
  });

  it("chunk 1 with non-zero start_offset → 409", async () => {
    const { token } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    await registerSession(token, sid);
    const bytes = new TextEncoder().encode("XXX");
    const res = await putChunk(token, sid, 1, bytes, 100, 0);
    expect(res.res.status).toBe(409);
    const body = await res.res.json() as { error: string };
    expect(body.error).toBe("non_contiguous_start");
  });

  it("wrong-generation PUT → 409 stale_generation", async () => {
    const { token } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    await registerSession(token, sid);
    const bytes = new TextEncoder().encode("hi");
    const res = await putChunk(token, sid, 1, bytes, 0, 5 /* wrong gen */);
    expect(res.res.status).toBe(409);
    const body = await res.res.json() as { error: string };
    expect(body.error).toBe("stale_generation");
  });

  it("sha256 mismatch → 400 sha256_mismatch", async () => {
    const { token } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    await registerSession(token, sid);
    const bytes = new TextEncoder().encode("the truth");
    const res = await signedFetch(
      `/api/sessions/bytes/${sid}/chunk/1`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-chunk-start-offset": "0",
          "x-chunk-end-offset": String(bytes.byteLength),
          "x-plaintext-sha256": "0".repeat(64),  // valid format, wrong digest
          "x-bytes-generation": "0",
        },
        body: bytes,
      },
      token,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("sha256_mismatch");
  });

  it("R2 inspection of any chunk shows ciphertext, never plaintext marker", async () => {
    const { token, userId } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    await registerSession(token, sid);
    const plaintext = new TextEncoder().encode("PLAINTEXT_MARKER_DO_NOT_LEAK");
    expect((await putChunk(token, sid, 1, plaintext, 0, 0)).res.status).toBe(200);
    const obj = await env.SESSIONS_BUCKET.get(`sessions/${userId}/${sid}/g0/chunk-1.bin`);
    expect(obj).not.toBeNull();
    const stored = new Uint8Array(await obj!.arrayBuffer());
    const decoded = new TextDecoder().decode(stored);
    expect(decoded).not.toContain("PLAINTEXT_MARKER_DO_NOT_LEAK");
  });

  it("cross-account intrusion → 404 session_not_found", async () => {
    const owner = await makeProSession();
    const intruder = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    await registerSession(owner.token, sid);
    const bytes = new TextEncoder().encode("nope");
    const res = await putChunk(intruder.token, sid, 1, bytes, 0, 0);
    expect(res.res.status).toBe(404);
  });
});

describe("active_device_id tracking + manifest exposure (#322 Pattern A)", () => {
  beforeAll(async () => { await applySchema(); });

  it("chunk PUT with x-bytes-device-id sets active_device_id; manifest GET returns it", async () => {
    const { token, userId } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    const macDeviceId = crypto.randomUUID();
    await registerSession(token, sid);
    const bytes = new TextEncoder().encode("from device A\n");
    expect((await putChunk(token, sid, 1, bytes, 0, 0, macDeviceId)).res.status).toBe(200);

    // Manifest exposes the active_device_id.
    const manifestRes = await signedFetch(`/api/sessions/bytes/${sid}/manifest`, { method: "GET" }, token);
    const manifest = await manifestRes.json() as { active_device_id: string | null };
    expect(manifest.active_device_id).toBe(macDeviceId);

    // Underlying D1 row confirms persistence.
    const row = await env.DB.prepare(
      `SELECT active_device_id FROM synced_session_metadata WHERE owner_id = ? AND session_id = ?`,
    ).bind(userId, sid).first<{ active_device_id: string }>();
    expect(row?.active_device_id).toBe(macDeviceId);
  });

  it("hand-off: a chunk PUT from a different device flips active_device_id", async () => {
    const { token, userId } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    const macDeviceId = crypto.randomUUID();
    const winDeviceId = crypto.randomUUID();
    await registerSession(token, sid);
    const c1 = new TextEncoder().encode("first\n");
    const c2 = new TextEncoder().encode("second from Windows\n");
    expect((await putChunk(token, sid, 1, c1, 0, 0, macDeviceId)).res.status).toBe(200);
    expect((await putChunk(token, sid, 2, c2, c1.byteLength, 0, winDeviceId)).res.status).toBe(200);

    const row = await env.DB.prepare(
      `SELECT active_device_id FROM synced_session_metadata WHERE owner_id = ? AND session_id = ?`,
    ).bind(userId, sid).first<{ active_device_id: string }>();
    expect(row?.active_device_id).toBe(winDeviceId);
  });

  it("malformed x-bytes-device-id is silently ignored (chunk still lands, column not touched)", async () => {
    // Validation defends D1 from arbitrary garbage in active_device_id, but a
    // malformed header is back-compat-friendly: the chunk PUT still succeeds,
    // the column just isn't bumped. Defence-in-depth, not a hard reject.
    const { token, userId } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    const goodDeviceId = crypto.randomUUID();
    await registerSession(token, sid);
    // Seed a valid active_device_id first.
    const c1 = new TextEncoder().encode("first\n");
    expect((await putChunk(token, sid, 1, c1, 0, 0, goodDeviceId)).res.status).toBe(200);
    // Now PUT chunk 2 with garbage in the header.
    const c2 = new TextEncoder().encode("second\n");
    expect((await putChunk(token, sid, 2, c2, c1.byteLength, 0, "not-a-uuid; DROP TABLE")).res.status).toBe(200);
    // active_device_id remains the original well-formed value.
    const row = await env.DB.prepare(
      `SELECT active_device_id FROM synced_session_metadata WHERE owner_id = ? AND session_id = ?`,
    ).bind(userId, sid).first<{ active_device_id: string }>();
    expect(row?.active_device_id).toBe(goodDeviceId);
  });

  it("chunk PUT without x-bytes-device-id leaves active_device_id unchanged (back-compat)", async () => {
    const { token, userId } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    await registerSession(token, sid);
    // Seed an existing active_device_id (as the migration's backfill would have).
    await env.DB.prepare(
      `UPDATE synced_session_metadata SET active_device_id = 'pre-existing-device' WHERE owner_id = ? AND session_id = ?`,
    ).bind(userId, sid).run();
    const bytes = new TextEncoder().encode("from a back-compat client\n");
    // No deviceId argument → header omitted.
    expect((await putChunk(token, sid, 1, bytes, 0, 0)).res.status).toBe(200);
    const row = await env.DB.prepare(
      `SELECT active_device_id FROM synced_session_metadata WHERE owner_id = ? AND session_id = ?`,
    ).bind(userId, sid).first<{ active_device_id: string }>();
    expect(row?.active_device_id).toBe("pre-existing-device");
  });
});

describe("POST /api/sessions/bytes/:id/reset (generation bump)", () => {
  beforeAll(async () => { await applySchema(); });

  it("reset bumps generation, manifest goes empty, stale-gen PUT rejected, new-gen PUT succeeds", async () => {
    const { token } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    await registerSession(token, sid);

    // Upload chunks in gen 0
    const a = new TextEncoder().encode("aaaa");
    const b = new TextEncoder().encode("bbbb");
    expect((await putChunk(token, sid, 1, a, 0, 0)).res.status).toBe(200);
    expect((await putChunk(token, sid, 2, b, 4, 0)).res.status).toBe(200);

    // Reset
    const resetRes = await signedFetch(`/api/sessions/bytes/${sid}/reset`, { method: "POST" }, token);
    expect(resetRes.status).toBe(200);
    const resetBody = await resetRes.json() as { previous_generation: number; current_generation: number };
    expect(resetBody.previous_generation).toBe(0);
    expect(resetBody.current_generation).toBe(1);

    // Manifest filtered to gen 1 is empty
    const manifestRes = await signedFetch(`/api/sessions/bytes/${sid}/manifest`, { method: "GET" }, token);
    const manifest = await manifestRes.json() as { bytes_generation: number; chunks: unknown[] };
    expect(manifest.bytes_generation).toBe(1);
    expect(manifest.chunks).toEqual([]);

    // Stale-gen PUT (gen 0) rejected
    const stale = await putChunk(token, sid, 3, new TextEncoder().encode("zzz"), 8, 0);
    expect(stale.res.status).toBe(409);

    // Fresh upload in gen 1 succeeds, chunk numbering restarts from 1
    const fresh = new TextEncoder().encode("FRESH");
    expect((await putChunk(token, sid, 1, fresh, 0, 1)).res.status).toBe(200);
    const finalManifest = await (await signedFetch(`/api/sessions/bytes/${sid}/manifest`, { method: "GET" }, token)).json() as { chunks: Array<{ chunk_number: number }> };
    expect(finalManifest.chunks.map((c) => c.chunk_number)).toEqual([1]);
  });
});

describe("AAD binding negative test", () => {
  beforeAll(async () => { await applySchema(); });

  it("decryption fails when AAD reconstructed from a tampered D1 row", async () => {
    const { token, userId } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    await registerSession(token, sid);

    const a = new TextEncoder().encode("AAA");
    expect((await putChunk(token, sid, 1, a, 0, 0)).res.status).toBe(200);
    const b = new TextEncoder().encode("BBB");
    expect((await putChunk(token, sid, 2, b, 3, 0)).res.status).toBe(200);

    // Tamper: swap chunk 1's plaintext_sha256 in D1 to chunk 2's value.
    // A GET for chunk 1 will reconstruct AAD with the tampered hash, which
    // does NOT match what was bound at encrypt — decrypt MUST fail.
    const chunk2Hash = await sha256Hex(b);
    await env.DB.prepare(
      `UPDATE synced_session_chunks SET plaintext_sha256 = ?
        WHERE owner_id = ? AND session_id = ? AND bytes_generation = 0 AND chunk_number = 1`,
    ).bind(chunk2Hash, userId, sid).run();

    const res = await signedFetch(`/api/sessions/bytes/${sid}/chunk/1`, { method: "GET" }, token);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("decrypt_failed");
  });
});

describe("GET manifest / chunk error paths", () => {
  beforeAll(async () => { await applySchema(); });

  it("manifest 404 when session not in caller's metadata", async () => {
    const { token } = await makeProSession();
    const res = await signedFetch(`/api/sessions/bytes/missing-id/manifest`, { method: "GET" }, token);
    expect(res.status).toBe(404);
  });

  it("chunk GET 404 when chunk doesn't exist", async () => {
    const { token } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    await registerSession(token, sid);
    const res = await signedFetch(`/api/sessions/bytes/${sid}/chunk/1`, { method: "GET" }, token);
    expect(res.status).toBe(404);
  });

  it("malformed percent-encoding in path → 400 invalid_session_id", async () => {
    const { token } = await makeProSession();
    const res = await signedFetch(`/api/sessions/bytes/bad%Gid/manifest`, { method: "GET" }, token);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_session_id");
  });
});
