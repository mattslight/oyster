import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { createSessionSyncService } from "../src/session-sync-service.js";
import { createProfileBindingService } from "../src/profile-binding-service.js";

// Minimal DB harness: just the columns SessionSyncService reads from sessions
// + the profile_binding table the gate checks. Mirrors the
// memory-sync-service.test.ts harness shape.
function harness() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id                    TEXT PRIMARY KEY,
      space_id              TEXT,
      agent                 TEXT NOT NULL,
      title                 TEXT,
      state                 TEXT NOT NULL,
      started_at            TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at              TEXT,
      model                 TEXT,
      last_event_at         TEXT NOT NULL DEFAULT (datetime('now')),
      last_offset           INTEGER NOT NULL DEFAULT 0,
      source_id             TEXT,
      cwd                   TEXT,
      sync_dirty_at         INTEGER,
      cloud_synced_at       INTEGER,
      cloud_owner_id        TEXT,
      jsonl_synced_at       INTEGER,
      jsonl_snapshot_offset INTEGER NOT NULL DEFAULT 0,
      jsonl_chunk_count     INTEGER NOT NULL DEFAULT 0,
      bytes_generation      INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE profile_binding (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cloud_owner_id TEXT NOT NULL,
      bound_at INTEGER NOT NULL
    );
  `);
  const profileBinding = createProfileBindingService({ db });
  return { db, profileBinding };
}

function insertDirtySession(
  db: Database.Database,
  id: string,
  ownerId: string,
  dirtyAt = Date.now(),
) {
  db.prepare(
    `INSERT INTO sessions (id, agent, state, last_event_at, sync_dirty_at, cloud_owner_id)
     VALUES (?, 'claude-code', 'done', datetime('now'), ?, ?)`,
  ).run(id, dirtyAt, ownerId);
}

describe("SessionSyncService", () => {
  it("reconcile is a no-op for free users", async () => {
    const { db, profileBinding } = harness();
    const fetchSpy = vi.fn();
    const svc = createSessionSyncService({
      db,
      profileBinding,
      currentUser: () => ({ id: "u1", email: "x@x", tier: "free" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy,
    });
    const r = await svc.reconcile();
    expect(r).toEqual({ pulled: 0, pushed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reconcile is a no-op when profile is bound to a different account", async () => {
    const { db, profileBinding } = harness();
    profileBinding.bindToOwner("user-A");
    const fetchSpy = vi.fn();
    const svc = createSessionSyncService({
      db,
      profileBinding,
      currentUser: () => ({ id: "user-B", email: "b@b", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy,
    });
    const r = await svc.reconcile();
    expect(r).toEqual({ pulled: 0, pushed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("markDirty sets sync_dirty_at + cloud_owner_id so the row becomes pending", () => {
    const { db, profileBinding } = harness();
    db.prepare(
      `INSERT INTO sessions (id, agent, state, last_event_at)
       VALUES ('s1', 'claude-code', 'active', datetime('now'))`,
    ).run();
    const svc = createSessionSyncService({
      db,
      profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: vi.fn(),
    });

    svc.markDirty("s1", "user-A", 1234);

    const row = db.prepare(
      "SELECT sync_dirty_at, cloud_owner_id FROM sessions WHERE id='s1'",
    ).get() as { sync_dirty_at: number; cloud_owner_id: string };
    expect(row.sync_dirty_at).toBe(1234);
    expect(row.cloud_owner_id).toBe("user-A");
  });

  it("pushPending sends dirty sessions for the current owner and marks them synced", async () => {
    const { db, profileBinding } = harness();
    profileBinding.bindToOwner("user-A");
    insertDirtySession(db, "s1", "user-A", 1000);
    insertDirtySession(db, "s2", "user-A", 2000);
    insertDirtySession(db, "s3", "other-user", 3000);  // belongs to another owner

    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ accepted: ["s1", "s2"] }), { status: 200 }),
    );
    const svc = createSessionSyncService({
      db,
      profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy,
    });

    const pushed = await svc.pushPending();

    expect(pushed).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toBe("https://example.com/api/sessions/metadata");
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.sessions.map((s: { id: string }) => s.id).sort()).toEqual(["s1", "s2"]);

    // s1 + s2 are now synced (cloud_synced_at >= sync_dirty_at)
    const s1 = db.prepare("SELECT cloud_synced_at, sync_dirty_at FROM sessions WHERE id='s1'")
      .get() as { cloud_synced_at: number; sync_dirty_at: number };
    expect(s1.cloud_synced_at).toBeGreaterThanOrEqual(s1.sync_dirty_at);
    // s3 (other owner) was never sent, never synced
    const s3 = db.prepare("SELECT cloud_synced_at FROM sessions WHERE id='s3'")
      .get() as { cloud_synced_at: number | null };
    expect(s3.cloud_synced_at).toBeNull();
  });
});

// pushBytes tests use a real on-disk jsonl under a tmp projects root.
import { mkdtempSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function setupBytesEnv() {
  const root = mkdtempSync(join(tmpdir(), "oyster-sync-bytes-"));
  process.env.OYSTER_CLAUDE_PROJECTS_ROOT = root;
  return root;
}

describe("SessionSyncService.pushBytes", () => {
  it("no-op for free user, no fetch fired", async () => {
    setupBytesEnv();
    const { db, profileBinding } = harness();
    db.prepare(
      `INSERT INTO sessions (id, agent, state, last_event_at, cwd, cloud_owner_id)
       VALUES ('s1', 'claude-code', 'done', datetime('now'), '/tmp/x', 'user-A')`,
    ).run();
    const fetchSpy = vi.fn();
    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "free" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy,
    });
    const r = await svc.pushBytes("s1");
    expect(r.uploaded).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no-op when session row has no cwd (orphan session)", async () => {
    setupBytesEnv();
    const { db, profileBinding } = harness();
    profileBinding.bindToOwner("user-A");
    db.prepare(
      `INSERT INTO sessions (id, agent, state, last_event_at, cwd, cloud_owner_id)
       VALUES ('s1', 'claude-code', 'done', datetime('now'), NULL, 'user-A')`,
    ).run();
    const fetchSpy = vi.fn();
    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy,
    });
    expect((await svc.pushBytes("s1")).uploaded).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uploads one chunk for a small file under MAX_CHUNK_BYTES", async () => {
    const root = setupBytesEnv();
    const { db, profileBinding } = harness();
    profileBinding.bindToOwner("user-A");
    const cwd = "/tmp/proj-a";
    // Mirror encodeCwd: every non-alphanumeric → '-'.
    const encoded = cwd.replace(/[^A-Za-z0-9]/g, "-");
    mkdirSync(join(root, encoded), { recursive: true });
    const jsonl = "{\"role\":\"user\",\"content\":\"hi\"}\n{\"role\":\"assistant\",\"content\":\"hello\"}\n";
    writeFileSync(join(root, encoded, "s1.jsonl"), jsonl);

    db.prepare(
      `INSERT INTO sessions (id, agent, state, last_event_at, cwd, cloud_owner_id)
       VALUES ('s1', 'claude-code', 'active', datetime('now'), ?, 'user-A')`,
    ).run(cwd);

    const calls: Array<{ url: string; chunkNumber: number; gen: number; body: Uint8Array }> = [];
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const m = u.match(/\/api\/sessions\/bytes\/([^/]+)\/chunk\/(\d+)$/);
      if (m && init?.method === "PUT") {
        const body = new Uint8Array(init.body as ArrayBuffer);
        calls.push({
          url: u,
          chunkNumber: Number(m[2]),
          gen: Number((init.headers as Record<string, string>)["x-bytes-generation"]),
          body,
        });
        return new Response(JSON.stringify({ ok: true, chunk_number: Number(m[2]), generation: 0 }), { status: 200 });
      }
      return new Response("not_found", { status: 404 });
    });

    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });

    const r = await svc.pushBytes("s1");
    expect(r.uploaded).toBe(1);
    expect(r.offsetAfter).toBe(statSync(join(root, encoded, "s1.jsonl")).size);
    expect(r.generation).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.chunkNumber).toBe(1);
    expect(calls[0]!.gen).toBe(0);
    expect(new TextDecoder().decode(calls[0]!.body)).toBe(jsonl);

    // Local state advanced
    const row = db.prepare(
      `SELECT jsonl_snapshot_offset, jsonl_chunk_count, jsonl_synced_at FROM sessions WHERE id='s1'`,
    ).get() as { jsonl_snapshot_offset: number; jsonl_chunk_count: number; jsonl_synced_at: number };
    expect(row.jsonl_snapshot_offset).toBe(jsonl.length);
    expect(row.jsonl_chunk_count).toBe(1);
    expect(row.jsonl_synced_at).toBeGreaterThan(0);
  });

  it("idempotent: a second pushBytes with no new bytes is a no-op (no fetch)", async () => {
    const root = setupBytesEnv();
    const { db, profileBinding } = harness();
    profileBinding.bindToOwner("user-A");
    const cwd = "/tmp/proj-b";
    const encoded = cwd.replace(/[^A-Za-z0-9]/g, "-");
    mkdirSync(join(root, encoded), { recursive: true });
    writeFileSync(join(root, encoded, "s1.jsonl"), "hello\n");
    db.prepare(
      `INSERT INTO sessions (id, agent, state, last_event_at, cwd, cloud_owner_id)
       VALUES ('s1', 'claude-code', 'active', datetime('now'), ?, 'user-A')`,
    ).run(cwd);

    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, chunk_number: 1, generation: 0 }), { status: 200 }),
    );
    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });

    await svc.pushBytes("s1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Second call — no new bytes
    await svc.pushBytes("s1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);  // unchanged
  });

  it("appended bytes upload as a new chunk with correct start_offset", async () => {
    const root = setupBytesEnv();
    const { db, profileBinding } = harness();
    profileBinding.bindToOwner("user-A");
    const cwd = "/tmp/proj-c";
    const encoded = cwd.replace(/[^A-Za-z0-9]/g, "-");
    mkdirSync(join(root, encoded), { recursive: true });
    const filePath = join(root, encoded, "s1.jsonl");
    writeFileSync(filePath, "line-1\n");
    db.prepare(
      `INSERT INTO sessions (id, agent, state, last_event_at, cwd, cloud_owner_id)
       VALUES ('s1', 'claude-code', 'active', datetime('now'), ?, 'user-A')`,
    ).run(cwd);

    const calls: Array<{ chunkNumber: number; startOffset: number; bodyText: string }> = [];
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const m = u.match(/\/chunk\/(\d+)$/);
      if (m && init?.method === "PUT") {
        const headers = init.headers as Record<string, string>;
        const body = new Uint8Array(init.body as ArrayBuffer);
        calls.push({
          chunkNumber: Number(m[1]),
          startOffset: Number(headers["x-chunk-start-offset"]),
          bodyText: new TextDecoder().decode(body),
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("not_found", { status: 404 });
    });
    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });

    await svc.pushBytes("s1");
    // Append a second line
    writeFileSync(filePath, "line-1\nline-2\n");
    await svc.pushBytes("s1");

    expect(calls).toHaveLength(2);
    expect(calls[0]!.chunkNumber).toBe(1);
    expect(calls[0]!.startOffset).toBe(0);
    expect(calls[0]!.bodyText).toBe("line-1\n");
    expect(calls[1]!.chunkNumber).toBe(2);
    expect(calls[1]!.startOffset).toBe(7);  // "line-1\n".length
    expect(calls[1]!.bodyText).toBe("line-2\n");
  });

  it("truncation: file shrank → calls /reset, bumps generation, restarts chunk numbering", async () => {
    const root = setupBytesEnv();
    const { db, profileBinding } = harness();
    profileBinding.bindToOwner("user-A");
    const cwd = "/tmp/proj-d";
    const encoded = cwd.replace(/[^A-Za-z0-9]/g, "-");
    mkdirSync(join(root, encoded), { recursive: true });
    const filePath = join(root, encoded, "s1.jsonl");
    writeFileSync(filePath, "old-content-that-will-be-replaced\n");
    db.prepare(
      `INSERT INTO sessions (id, agent, state, last_event_at, cwd, cloud_owner_id)
       VALUES ('s1', 'claude-code', 'active', datetime('now'), ?, 'user-A')`,
    ).run(cwd);

    const events: Array<{ kind: "reset" | "chunk"; chunkNumber?: number; gen?: number }> = [];
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/reset") && init?.method === "POST") {
        events.push({ kind: "reset" });
        return new Response(JSON.stringify({ ok: true, previous_generation: 0, current_generation: 1 }), { status: 200 });
      }
      const m = u.match(/\/chunk\/(\d+)$/);
      if (m && init?.method === "PUT") {
        const headers = init.headers as Record<string, string>;
        events.push({
          kind: "chunk",
          chunkNumber: Number(m[1]),
          gen: Number(headers["x-bytes-generation"]),
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("not_found", { status: 404 });
    });
    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });

    // First push (gen 0, chunk 1)
    await svc.pushBytes("s1");
    expect(events).toEqual([{ kind: "chunk", chunkNumber: 1, gen: 0 }]);

    // Now truncate: file shrinks to a smaller size
    writeFileSync(filePath, "new\n");

    events.length = 0;
    const r = await svc.pushBytes("s1");
    expect(r.resetFired).toBe(true);
    expect(r.generation).toBe(1);
    // Expect reset call THEN chunk 1 upload in new generation
    expect(events).toEqual([
      { kind: "reset" },
      { kind: "chunk", chunkNumber: 1, gen: 1 },
    ]);

    // Local state reflects new generation
    const row = db.prepare(
      `SELECT bytes_generation, jsonl_chunk_count, jsonl_snapshot_offset FROM sessions WHERE id='s1'`,
    ).get() as { bytes_generation: number; jsonl_chunk_count: number; jsonl_snapshot_offset: number };
    expect(row.bytes_generation).toBe(1);
    expect(row.jsonl_chunk_count).toBe(1);
    expect(row.jsonl_snapshot_offset).toBe(4);  // "new\n".length
  });
});

