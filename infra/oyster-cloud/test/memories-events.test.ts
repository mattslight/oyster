import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";
import { applySchema } from "./fixtures/seed.js";

describe("synced_memory_events / synced_memory_payloads schema", () => {
  beforeAll(async () => {
    await applySchema();
  });

  it("has the events table with expected columns", async () => {
    const { results } = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('synced_memory_events') ORDER BY name`,
    ).all<{ name: string }>();
    const names = (results ?? []).map((r) => r.name);
    expect(names).toEqual([
      "created_at", "event_id", "event_type", "ingested_at", "memory_id", "owner_id", "space_id",
    ]);
  });

  it("has the payloads table with expected columns", async () => {
    const { results } = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('synced_memory_payloads') ORDER BY name`,
    ).all<{ name: string }>();
    const names = (results ?? []).map((r) => r.name);
    expect(names).toEqual(["content", "memory_id", "owner_id", "purged_at", "tags"]);
  });

  it("enforces per-type uniqueness on memory_created", async () => {
    await env.DB.prepare(
      `INSERT INTO synced_memory_events (owner_id, event_id, memory_id, event_type, space_id, created_at, ingested_at)
       VALUES ('user-A', 'ev-1', 'mem-1', 'memory_created', NULL, 1000, 2000)`,
    ).run();
    await expect(env.DB.prepare(
      `INSERT INTO synced_memory_events (owner_id, event_id, memory_id, event_type, space_id, created_at, ingested_at)
       VALUES ('user-A', 'ev-2', 'mem-1', 'memory_created', NULL, 1500, 2500)`,
    ).run()).rejects.toThrow();
  });
});

// --- helpers for POST tests ---

async function signedInRequest(path: string, init: RequestInit, sessionToken: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", `oyster_session=${sessionToken}`);
  return SELF.fetch(`https://example.com${path}`, { ...init, headers });
}

// Each call inserts a fresh Pro user + session with a unique suffix.
// The sessions table uses `id` as PK (matching the seed schema and resolveSession).
// users.created_at is NOT NULL per the seed schema.
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

describe("POST /api/memories/events", () => {
  beforeAll(async () => {
    await applySchema();
  });

  it("rejects unsigned requests with 401", async () => {
    const res = await SELF.fetch("https://example.com/api/memories/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects free-tier users with 403", async () => {
    const userId = `u-free-${crypto.randomUUID()}`;
    const token  = `tok-free-${crypto.randomUUID()}`;
    await env.DB.prepare(`INSERT INTO users (id, email, tier, created_at) VALUES (?, ?, 'free', ?)`)
      .bind(userId, `free-${userId}@example.com`, Date.now()).run();
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL)`,
    ).bind(token, userId, Date.now(), Date.now() + 86400_000).run();

    const res = await signedInRequest("/api/memories/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [] }),
    }, token);
    expect(res.status).toBe(403);
  });

  it("ingests a memory_created event with payload", async () => {
    const { token, userId } = await makeProSession();
    const res = await signedInRequest("/api/memories/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{
          event_id:  "ev-1",
          memory_id: "mem-1",
          event_type: "memory_created",
          space_id: null,
          created_at: 1000,
          payload: { content: "hello", tags: ["a"] },
        }],
      }),
    }, token);
    expect(res.status).toBe(200);
    const body = await res.json() as { accepted: string[]; duplicates: string[]; conflicts: string[]; rejected: string[] };
    expect(body.accepted).toEqual(["ev-1"]);
    expect(body.duplicates).toEqual([]);
    expect(body.conflicts).toEqual([]);
    expect(body.rejected).toEqual([]);

    const ev = await env.DB.prepare(
      `SELECT event_type FROM synced_memory_events WHERE owner_id = ? AND event_id = ?`,
    ).bind(userId, "ev-1").first<{ event_type: string }>();
    expect(ev?.event_type).toBe("memory_created");

    const pay = await env.DB.prepare(
      `SELECT content FROM synced_memory_payloads WHERE owner_id = ? AND memory_id = ?`,
    ).bind(userId, "mem-1").first<{ content: string }>();
    expect(pay?.content).toBe("hello");
  });

  it("duplicate event_id is reported as `duplicates`, not `accepted`", async () => {
    const { token } = await makeProSession();
    const event = {
      event_id:  "ev-dup",
      memory_id: "mem-dup",
      event_type: "memory_created" as const,
      space_id: null,
      created_at: 1000,
      payload: { content: "x", tags: [] },
    };
    const first  = await signedInRequest("/api/memories/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [event] }) }, token);
    expect((await first.json() as any).accepted).toEqual(["ev-dup"]);
    const second = await signedInRequest("/api/memories/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [event] }) }, token);
    const body = await second.json() as { accepted: string[]; duplicates: string[]; conflicts: string[]; rejected: string[] };
    expect(body.duplicates).toEqual(["ev-dup"]);
    expect(body.accepted).toEqual([]);
  });

  it("second create for same memory_id with different event_id is `conflicts`", async () => {
    const { token } = await makeProSession();
    const first  = await signedInRequest("/api/memories/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ event_id: "ev-A", memory_id: "mem-Z", event_type: "memory_created", space_id: null, created_at: 1000, payload: { content: "first", tags: [] } }] }) }, token);
    expect((await first.json() as any).accepted).toEqual(["ev-A"]);
    const second = await signedInRequest("/api/memories/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ event_id: "ev-B", memory_id: "mem-Z", event_type: "memory_created", space_id: null, created_at: 2000, payload: { content: "second", tags: [] } }] }) }, token);
    const body = await second.json() as { accepted: string[]; conflicts: string[] };
    expect(body.conflicts).toEqual(["ev-B"]);
  });

  it("rejects malformed events; surfaces them in `rejected`", async () => {
    const { token } = await makeProSession();
    const res = await signedInRequest("/api/memories/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          { event_id: "ev-good", memory_id: "mem-G", event_type: "memory_created", space_id: null, created_at: 1, payload: { content: "ok", tags: [] } },
          { event_id: "ev-bad-type", memory_id: "mem-B1", event_type: "lol", space_id: null, created_at: 1 },
          { event_id: "ev-bad-empty-id", memory_id: "", event_type: "memory_created", space_id: null, created_at: 1, payload: { content: "x", tags: [] } },
          { event_id: "", memory_id: "mem-B3", event_type: "memory_created", space_id: null, created_at: 1, payload: { content: "x", tags: [] } },
        ],
      }),
    }, token);
    const body = await res.json() as { accepted: string[]; rejected: string[] };
    expect(body.accepted).toEqual(["ev-good"]);
    expect(body.rejected).toEqual(expect.arrayContaining(["ev-bad-type", "ev-bad-empty-id", "<malformed>"]));
  });

  it("rejects memory_created without payload when no purge exists", async () => {
    const { token } = await makeProSession();
    const res = await signedInRequest("/api/memories/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{ event_id: "ev-empty", memory_id: "mem-E", event_type: "memory_created", space_id: null, created_at: 1 }],
      }),
    }, token);
    const body = await res.json() as { accepted: string[]; rejected: string[] };
    expect(body.rejected).toEqual(["ev-empty"]);
    expect(body.accepted).toEqual([]);
  });

  it("accepts memory_created without payload when a purge already exists in the same batch (sorted first)", async () => {
    const { token, userId } = await makeProSession();
    const res = await signedInRequest("/api/memories/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          // Client writes create then purge; sort puts purge first.
          { event_id: "ev-c", memory_id: "mem-Y", event_type: "memory_created", space_id: null, created_at: 1000 },
          { event_id: "ev-p", memory_id: "mem-Y", event_type: "memory_purged",  space_id: null, created_at: 2000 },
        ],
      }),
    }, token);
    const body = await res.json() as { accepted: string[]; rejected: string[] };
    expect(body.accepted.sort()).toEqual(["ev-c", "ev-p"].sort());
    expect(body.rejected).toEqual([]);
    const pay = await env.DB.prepare(
      `SELECT content, purged_at FROM synced_memory_payloads WHERE owner_id = ? AND memory_id = ?`,
    ).bind(userId, "mem-Y").first<{ content: string | null; purged_at: number | null }>();
    expect(pay?.content).toBeNull();
    expect(pay?.purged_at).not.toBeNull();
  });

  it("memory_purged nulls payload content even if create arrives later", async () => {
    const { token, userId } = await makeProSession();
    // Send purge first (out-of-order delivery).
    await signedInRequest("/api/memories/events", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{
          event_id: "ev-purge", memory_id: "mem-X", event_type: "memory_purged",
          space_id: null, created_at: 2000,
        }],
      }),
    }, token);
    // Then send create with content.
    await signedInRequest("/api/memories/events", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{
          event_id: "ev-create", memory_id: "mem-X", event_type: "memory_created",
          space_id: null, created_at: 1000,
          payload: { content: "should-not-survive", tags: [] },
        }],
      }),
    }, token);
    const pay = await env.DB.prepare(
      `SELECT content, purged_at FROM synced_memory_payloads WHERE owner_id = ? AND memory_id = ?`,
    ).bind(userId, "mem-X").first<{ content: string | null; purged_at: number | null }>();
    expect(pay?.content).toBeNull();
    expect(pay?.purged_at).not.toBeNull();
  });
});
