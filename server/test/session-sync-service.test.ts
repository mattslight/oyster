import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { createSessionSyncService, LocalDivergedError } from "../src/session-sync-service.js";
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
      bytes_generation      INTEGER NOT NULL DEFAULT 0,
      jsonl_path            TEXT
    );
    CREATE TABLE profile_binding (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cloud_owner_id TEXT NOT NULL,
      bound_at INTEGER NOT NULL
    );
    CREATE TABLE device_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      device_id TEXT NOT NULL,
      label TEXT NOT NULL
    );
    CREATE TABLE remote_sessions (
      session_id        TEXT NOT NULL,
      owner_id          TEXT NOT NULL,
      device_id         TEXT,
      device_label      TEXT,
      agent             TEXT NOT NULL,
      title             TEXT,
      state             TEXT NOT NULL,
      cwd               TEXT,
      model             TEXT,
      started_at        TEXT NOT NULL,
      ended_at          TEXT,
      last_event_at     TEXT NOT NULL,
      bytes_generation  INTEGER NOT NULL DEFAULT 0,
      has_bytes         INTEGER NOT NULL DEFAULT 0,
      active_device_id  TEXT,
      cloud_updated_at  INTEGER NOT NULL,
      fetched_at        INTEGER NOT NULL,
      jsonl_local_path  TEXT,
      PRIMARY KEY (owner_id, session_id)
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

  it("pushPending stamps device_id and device_label from device_identity onto every payload row", async () => {
    const { db, profileBinding } = harness();
    profileBinding.bindToOwner("user-A");
    db.prepare(`INSERT INTO device_identity (id, device_id, label) VALUES (1, ?, ?)`)
      .run("my-mac-uuid", "MacBook-Pro");
    insertDirtySession(db, "s1", "user-A", 1000);

    let capturedBody: string | null = null;
    const fetchSpy = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ accepted: ["s1"] }), { status: 200 });
    });
    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    await svc.pushPending();
    const body = JSON.parse(capturedBody ?? "{}") as {
      sessions: Array<{ id: string; device_id: string | null; device_label: string | null }>
    };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.device_id).toBe("my-mac-uuid");
    // device_label rides alongside so Device B can render "From MacBook-Pro"
    // without needing a separate hostname-lookup round-trip.
    expect(body.sessions[0]!.device_label).toBe("MacBook-Pro");
  });

  it("pushPending tolerates missing device_identity (device_id null in payload)", async () => {
    const { db, profileBinding } = harness();
    profileBinding.bindToOwner("user-A");
    // device_identity intentionally NOT seeded
    insertDirtySession(db, "s1", "user-A", 1000);

    let capturedBody: string | null = null;
    const fetchSpy = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ accepted: ["s1"] }), { status: 200 });
    });
    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    await svc.pushPending();
    const body = JSON.parse(capturedBody ?? "{}") as { sessions: Array<{ device_id: string | null }> };
    expect(body.sessions[0]!.device_id).toBeNull();
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

describe("SessionSyncService.reassembleSessionJsonl", () => {
  function hash(bytes: Uint8Array): string {
    // Same algo + format as the service (Node crypto SHA-256 hex).
    // Use a worker-side equivalent: hash via crypto.subtle on the actual bytes.
    // For brevity here we just import the runtime's createHash.
    // (Mirror of sha256Hex in session-sync-service.)
    // We do this synchronously via require to keep this test file simple.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createHash } = require("node:crypto");
    return createHash("sha256").update(bytes).digest("hex");
  }

  function makeFetch(
    chunks: Uint8Array[],
    generation = 0,
    overrides: { manifestStatus?: number; chunkStatus?: number; corruptChunk?: number } = {},
  ): typeof fetch {
    return (vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/manifest")) {
        if (overrides.manifestStatus && overrides.manifestStatus !== 200) {
          return new Response("err", { status: overrides.manifestStatus });
        }
        let off = 0;
        const manifestChunks = chunks.map((c, i) => {
          const start = off;
          off += c.byteLength;
          return {
            chunk_number: i + 1,
            start_offset: start,
            end_offset: off,
            byte_count: c.byteLength,
            plaintext_sha256: hash(c),
          };
        });
        return new Response(JSON.stringify({
          bytes_generation: generation,
          total_size: off,
          chunks: manifestChunks,
        }), { status: 200 });
      }
      const m = u.match(/\/chunk\/(\d+)$/);
      if (m) {
        const idx = Number(m[1]) - 1;
        if (overrides.chunkStatus && overrides.chunkStatus !== 200) {
          return new Response("err", { status: overrides.chunkStatus });
        }
        let bytes = chunks[idx]!;
        if (overrides.corruptChunk === idx + 1) {
          // Same-length corruption — exercises the hash check specifically,
          // not the byte-count check that fires earlier on size mismatch.
          bytes = new Uint8Array(bytes.byteLength);
          bytes.fill(0xff);
        }
        return new Response(bytes, { status: 200 });
      }
      return new Response("not_found", { status: 404 });
    }) as unknown as typeof fetch);
  }

  function harnessForReassemble(): { db: Database.Database; profileBinding: ReturnType<typeof createProfileBindingService> } {
    const h = harness();
    h.profileBinding.bindToOwner("user-A");
    h.db.prepare(`INSERT INTO device_identity (id, device_id, label) VALUES (1, 'dev-mac', 'test')`).run();
    h.db.prepare(`
      INSERT INTO remote_sessions
        (session_id, owner_id, device_id, agent, title, state, cwd, model,
         started_at, ended_at, last_event_at, bytes_generation, has_bytes,
         cloud_updated_at, fetched_at, jsonl_local_path)
      VALUES ('s-remote', 'user-A', 'dev-pc', 'claude-code', 't', 'done', '/tmp/x', 'm',
              '2026-05-11T10:00:00Z', NULL, '2026-05-11T10:30:00Z',
              0, 1, 1000, ?, NULL)
    `).run(Date.now());
    return h;
  }

  it("happy path: chunks reassemble byte-for-byte and remote_sessions.jsonl_local_path is set", async () => {
    const { db, profileBinding } = harnessForReassemble();
    const root = setupBytesEnv();
    const targetPath = join(root, "reassembled.jsonl");
    const c1 = new TextEncoder().encode("{\"role\":\"user\",\"content\":\"hi\"}\n");
    const c2 = new TextEncoder().encode("{\"role\":\"assistant\",\"content\":\"hey\"}\n");
    const c3 = new TextEncoder().encode("{\"role\":\"user\",\"content\":\"bye\"}\n");

    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: makeFetch([c1, c2, c3]),
    });
    const r = await svc.reassembleSessionJsonl("s-remote", targetPath);

    expect(r.chunkCount).toBe(3);
    expect(r.totalBytes).toBe(c1.byteLength + c2.byteLength + c3.byteLength);
    expect(r.generation).toBe(0);

    const expected = new Uint8Array(r.totalBytes);
    expected.set(c1, 0);
    expected.set(c2, c1.byteLength);
    expected.set(c3, c1.byteLength + c2.byteLength);
    const got = new Uint8Array(statSync(targetPath).size);
    // Read back from disk
    const fs = require("node:fs");
    fs.readFileSync(targetPath).copy(got);
    expect(got).toEqual(expected);

    // jsonl_local_path got recorded
    const row = db.prepare(
      `SELECT jsonl_local_path FROM remote_sessions WHERE owner_id = ? AND session_id = ?`,
    ).get("user-A", "s-remote") as { jsonl_local_path: string };
    expect(row.jsonl_local_path).toBe(targetPath);
  });

  it("hash mismatch deletes partial + throws + leaves no jsonl on disk", async () => {
    const { db, profileBinding } = harnessForReassemble();
    const root = setupBytesEnv();
    const targetPath = join(root, "reassembled.jsonl");
    const c1 = new TextEncoder().encode("good\n");
    const c2 = new TextEncoder().encode("also good\n");

    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: makeFetch([c1, c2], 0, { corruptChunk: 2 }),
    });
    await expect(svc.reassembleSessionJsonl("s-remote", targetPath)).rejects.toThrow(/hash mismatch/);

    // No file on disk
    const fs = require("node:fs");
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(fs.existsSync(`${targetPath}.partial`)).toBe(false);
    // jsonl_local_path stayed NULL
    const row = db.prepare(
      `SELECT jsonl_local_path FROM remote_sessions WHERE owner_id = ? AND session_id = ?`,
    ).get("user-A", "s-remote") as { jsonl_local_path: string | null };
    expect(row.jsonl_local_path).toBeNull();
  });

  it("catch-up: existing local file equal to cloud total is a no-op (no chunk fetches)", async () => {
    const { db, profileBinding } = harnessForReassemble();
    const root = setupBytesEnv();
    const targetPath = join(root, "already-synced.jsonl");
    const c1 = new TextEncoder().encode("event one\n");
    const c2 = new TextEncoder().encode("event two\n");

    // Pre-populate the local file with the exact contents the manifest will
    // describe. Catch-up should detect local == cloud and skip fetches.
    const fs = require("node:fs");
    fs.writeFileSync(targetPath, Buffer.concat([c1, c2]));

    let chunkFetches = 0;
    const fetchSpy = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/manifest")) {
        return new Response(JSON.stringify({
          bytes_generation: 0,
          total_size: c1.byteLength + c2.byteLength,
          active_device_id: "dev-mac",
          chunks: [
            { chunk_number: 1, start_offset: 0, end_offset: c1.byteLength, byte_count: c1.byteLength, plaintext_sha256: hash(c1) },
            { chunk_number: 2, start_offset: c1.byteLength, end_offset: c1.byteLength + c2.byteLength, byte_count: c2.byteLength, plaintext_sha256: hash(c2) },
          ],
        }), { status: 200 });
      }
      if (u.includes("/chunk/")) chunkFetches++;
      return new Response("should not fetch", { status: 500 });
    });

    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const r = await svc.reassembleSessionJsonl("s-remote", targetPath);
    expect(r.totalBytes).toBe(c1.byteLength + c2.byteLength);
    // No chunks fetched ⇒ chunkCount reports 0 (per ReassembleResult contract).
    expect(r.chunkCount).toBe(0);
    expect(chunkFetches).toBe(0);
    // remote_sessions.jsonl_local_path is set even for no-op
    const row = db.prepare(
      `SELECT jsonl_local_path FROM remote_sessions WHERE owner_id = ? AND session_id = ?`,
    ).get("user-A", "s-remote") as { jsonl_local_path: string };
    expect(row.jsonl_local_path).toBe(targetPath);
  });

  it("catch-up: local at chunk-1 boundary fetches only the missing tail (chunk 2+)", async () => {
    const { db, profileBinding } = harnessForReassemble();
    const root = setupBytesEnv();
    const targetPath = join(root, "behind.jsonl");
    const c1 = new TextEncoder().encode("first\n");
    const c2 = new TextEncoder().encode("second\n");
    const c3 = new TextEncoder().encode("third\n");

    // Local has chunks 1 only.
    const fs = require("node:fs");
    fs.writeFileSync(targetPath, c1);

    const chunkFetches: number[] = [];
    const fetchSpy = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/manifest")) {
        return new Response(JSON.stringify({
          bytes_generation: 0,
          total_size: c1.byteLength + c2.byteLength + c3.byteLength,
          active_device_id: "dev-pc",
          chunks: [
            { chunk_number: 1, start_offset: 0, end_offset: c1.byteLength, byte_count: c1.byteLength, plaintext_sha256: hash(c1) },
            { chunk_number: 2, start_offset: c1.byteLength, end_offset: c1.byteLength + c2.byteLength, byte_count: c2.byteLength, plaintext_sha256: hash(c2) },
            { chunk_number: 3, start_offset: c1.byteLength + c2.byteLength, end_offset: c1.byteLength + c2.byteLength + c3.byteLength, byte_count: c3.byteLength, plaintext_sha256: hash(c3) },
          ],
        }), { status: 200 });
      }
      const m = u.match(/\/chunk\/(\d+)$/);
      if (m) {
        const n = Number(m[1]);
        chunkFetches.push(n);
        const bytes = n === 2 ? c2 : n === 3 ? c3 : c1;
        return new Response(bytes, { status: 200 });
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
    const r = await svc.reassembleSessionJsonl("s-remote", targetPath);
    // Only chunks 2 + 3 fetched; chunk 1 reused from local.
    expect(chunkFetches.sort()).toEqual([2, 3]);
    expect(r.chunkCount).toBe(2);
    expect(r.totalBytes).toBe(c1.byteLength + c2.byteLength + c3.byteLength);

    const fs2 = require("node:fs");
    const reassembled = fs2.readFileSync(targetPath) as Buffer;
    expect(reassembled.equals(Buffer.concat([c1, c2, c3]))).toBe(true);
  });

  it("divergence: local jsonl larger than cloud total throws local_diverged", async () => {
    const { db, profileBinding } = harnessForReassemble();
    const root = setupBytesEnv();
    const targetPath = join(root, "divergent.jsonl");
    const c1 = new TextEncoder().encode("first\n");
    const local = new TextEncoder().encode("first\nlocal-only-edits-not-in-cloud\n");

    const fs = require("node:fs");
    fs.writeFileSync(targetPath, local);

    const fetchSpy = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/manifest")) {
        return new Response(JSON.stringify({
          bytes_generation: 0,
          total_size: c1.byteLength,
          active_device_id: "dev-pc",
          chunks: [
            { chunk_number: 1, start_offset: 0, end_offset: c1.byteLength, byte_count: c1.byteLength, plaintext_sha256: hash(c1) },
          ],
        }), { status: 200 });
      }
      return new Response("should not fetch", { status: 500 });
    });

    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    await expect(svc.reassembleSessionJsonl("s-remote", targetPath))
      .rejects.toBeInstanceOf(LocalDivergedError);
    // Local file untouched
    const fs2 = require("node:fs");
    const after = fs2.readFileSync(targetPath) as Buffer;
    expect(after.equals(local)).toBe(true);
  });

  it("divergence: local jsonl mid-chunk (no matching boundary) throws local_diverged", async () => {
    const { db, profileBinding } = harnessForReassemble();
    const root = setupBytesEnv();
    const targetPath = join(root, "mid-chunk.jsonl");
    const c1 = new TextEncoder().encode("aaaaa");  // 5 bytes
    const c2 = new TextEncoder().encode("bbbbb");  // 5 bytes
    // Local has 7 bytes — doesn't match either boundary (0, 5, 10).
    const fs = require("node:fs");
    fs.writeFileSync(targetPath, new TextEncoder().encode("aaaaabb"));

    const fetchSpy = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/manifest")) {
        return new Response(JSON.stringify({
          bytes_generation: 0,
          total_size: 10,
          active_device_id: "dev-pc",
          chunks: [
            { chunk_number: 1, start_offset: 0, end_offset: 5, byte_count: 5, plaintext_sha256: hash(c1) },
            { chunk_number: 2, start_offset: 5, end_offset: 10, byte_count: 5, plaintext_sha256: hash(c2) },
          ],
        }), { status: 200 });
      }
      return new Response("should not fetch", { status: 500 });
    });

    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    await expect(svc.reassembleSessionJsonl("s-remote", targetPath))
      .rejects.toBeInstanceOf(LocalDivergedError);
  });

  it("seeds local sessions bookkeeping on successful fresh reassemble", async () => {
    // Without this seed, a subsequent claude --resume appends new bytes,
    // the watcher creates a sessions row with jsonl_snapshot_offset = 0,
    // and pushBytes tries to re-upload chunk 1 → cloud returns 409
    // chunk_conflict because the chain already has chunk 1 from the origin
    // device. The seed makes pushBytes start at expectedTotal so the next
    // push goes as chunk N+1 and the chain stays linear (Pattern A).
    const { db, profileBinding } = harnessForReassemble();
    const root = setupBytesEnv();
    const targetPath = join(root, "fresh.jsonl");
    const c1 = new TextEncoder().encode("only-chunk\n");

    const fetchSpy = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/manifest")) {
        return new Response(JSON.stringify({
          bytes_generation: 3,
          total_size: c1.byteLength,
          active_device_id: "dev-origin",
          chunks: [
            { chunk_number: 1, start_offset: 0, end_offset: c1.byteLength, byte_count: c1.byteLength, plaintext_sha256: hash(c1) },
          ],
        }), { status: 200 });
      }
      if (u.includes("/chunk/")) return new Response(c1, { status: 200 });
      return new Response("not_found", { status: 404 });
    });

    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    await svc.reassembleSessionJsonl("s-remote", targetPath);

    const row = db.prepare(
      `SELECT jsonl_path, jsonl_snapshot_offset, jsonl_chunk_count, bytes_generation,
              cloud_owner_id, last_event_at, jsonl_synced_at, cloud_synced_at
         FROM sessions WHERE id = 's-remote'`,
    ).get() as {
      jsonl_path: string;
      jsonl_snapshot_offset: number;
      jsonl_chunk_count: number;
      bytes_generation: number;
      cloud_owner_id: string;
      last_event_at: string;
      jsonl_synced_at: number | null;
      cloud_synced_at: number | null;
    };
    expect(row.jsonl_path).toBe(targetPath);
    expect(row.jsonl_snapshot_offset).toBe(c1.byteLength);
    expect(row.jsonl_chunk_count).toBe(1);
    expect(row.bytes_generation).toBe(3);
    expect(row.cloud_owner_id).toBe("user-A");
    // last_event_at must come from remote_sessions (cloud truth), not NOW —
    // otherwise the watcher's MAX(...) upsert ratchets the column forward
    // and the home feed shows the wrong timestamp until a new event lands.
    // Harness seeds remote_sessions with '2026-05-11T10:30:00Z'.
    expect(row.last_event_at).toBe("2026-05-11T10:30:00Z");
    // Bytes-side ack lives in jsonl_synced_at. cloud_synced_at is for the
    // metadata push ack; touching it here would corrupt the dirty predicate.
    expect(row.jsonl_synced_at).toBeGreaterThan(0);
    expect(row.cloud_synced_at).toBeNull();
  });

  it("seed does not clobber a dirty row's cloud_synced_at (metadata push ack stays intact)", async () => {
    // Regression: an earlier draft of the seed wrote cloud_synced_at,
    // which is the *metadata* push-ack timestamp used by the dirty
    // predicate. Writing it here can falsely mark a dirty row as synced
    // and lose a pending metadata push. Seed must touch only jsonl_synced_at.
    const { db, profileBinding } = harnessForReassemble();
    const root = setupBytesEnv();
    const targetPath = join(root, "dirty.jsonl");
    const c1 = new TextEncoder().encode("x\n");
    const fs = require("node:fs");
    fs.writeFileSync(targetPath, c1);

    // Pre-existing dirty row: sync_dirty_at > cloud_synced_at = predicate "dirty"
    db.prepare(
      `INSERT INTO sessions (id, agent, state, last_event_at,
                             jsonl_path, jsonl_snapshot_offset, jsonl_chunk_count, bytes_generation,
                             cloud_owner_id, sync_dirty_at, cloud_synced_at)
       VALUES ('s-remote', 'claude-code', 'active', datetime('now'),
               ?, 0, 0, 0,
               'user-A', 2000, 1000)`,
    ).run(targetPath);

    const fetchSpy = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/manifest")) {
        return new Response(JSON.stringify({
          bytes_generation: 0,
          total_size: c1.byteLength,
          active_device_id: "dev-mac",
          chunks: [
            { chunk_number: 1, start_offset: 0, end_offset: c1.byteLength, byte_count: c1.byteLength, plaintext_sha256: hash(c1) },
          ],
        }), { status: 200 });
      }
      return new Response("should not fetch", { status: 500 });
    });

    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    await svc.reassembleSessionJsonl("s-remote", targetPath);

    const row = db.prepare(
      `SELECT sync_dirty_at, cloud_synced_at FROM sessions WHERE id = 's-remote'`,
    ).get() as { sync_dirty_at: number; cloud_synced_at: number };
    // Untouched: row is still dirty by the predicate (sync_dirty_at > cloud_synced_at).
    expect(row.sync_dirty_at).toBe(2000);
    expect(row.cloud_synced_at).toBe(1000);
  });

  it("re-seeds bookkeeping on no-op reassemble (heals existing 0/0/0 rows)", async () => {
    // For the user who hit this bug in beta.7: sessions.jsonl_path correct
    // but snapshot_offset/chunk_count/generation all 0 because the original
    // reassemble didn't seed. Calling reassemble again on a fully-synced
    // local file should re-seed the bookkeeping (the no-op exit path
    // also seeds).
    const { db, profileBinding } = harnessForReassemble();
    const root = setupBytesEnv();
    const targetPath = join(root, "already-synced-seed.jsonl");
    const c1 = new TextEncoder().encode("one\n");
    const c2 = new TextEncoder().encode("two\n");
    const fs = require("node:fs");
    fs.writeFileSync(targetPath, Buffer.concat([c1, c2]));

    // Pre-existing row simulating the beta.7 bug state.
    db.prepare(
      `INSERT INTO sessions (id, agent, state, last_event_at, jsonl_path, jsonl_snapshot_offset, jsonl_chunk_count, bytes_generation, cloud_owner_id)
       VALUES ('s-remote', 'claude-code', 'active', datetime('now'), ?, 0, 0, 0, 'user-A')`,
    ).run(targetPath);

    const fetchSpy = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/manifest")) {
        return new Response(JSON.stringify({
          bytes_generation: 0,
          total_size: c1.byteLength + c2.byteLength,
          active_device_id: "dev-mac",
          chunks: [
            { chunk_number: 1, start_offset: 0, end_offset: c1.byteLength, byte_count: c1.byteLength, plaintext_sha256: hash(c1) },
            { chunk_number: 2, start_offset: c1.byteLength, end_offset: c1.byteLength + c2.byteLength, byte_count: c2.byteLength, plaintext_sha256: hash(c2) },
          ],
        }), { status: 200 });
      }
      return new Response("should not fetch", { status: 500 });
    });

    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    await svc.reassembleSessionJsonl("s-remote", targetPath);

    const row = db.prepare(
      `SELECT jsonl_snapshot_offset, jsonl_chunk_count FROM sessions WHERE id = 's-remote'`,
    ).get() as { jsonl_snapshot_offset: number; jsonl_chunk_count: number };
    expect(row.jsonl_snapshot_offset).toBe(c1.byteLength + c2.byteLength);
    expect(row.jsonl_chunk_count).toBe(2);
  });

  it("free user throws (pro-only)", async () => {
    const { db, profileBinding } = harnessForReassemble();
    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "free" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: vi.fn() as unknown as typeof fetch,
    });
    await expect(svc.reassembleSessionJsonl("s-remote", "/tmp/x.jsonl"))
      .rejects.toThrow(/pro-only/);
  });

  it("empty manifest throws", async () => {
    const { db, profileBinding } = harnessForReassemble();
    const root = setupBytesEnv();
    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: makeFetch([]),
    });
    await expect(svc.reassembleSessionJsonl("s-remote", join(root, "out.jsonl")))
      .rejects.toThrow(/no chunks/);
  });
});

describe("SessionSyncService.pull", () => {
  function seedDevice(db: Database.Database, deviceId = "dev-mac"): void {
    db.prepare(
      `INSERT INTO device_identity (id, device_id, label) VALUES (1, ?, 'test')`,
    ).run(deviceId);
  }

  function cloudPayload(sessions: Array<{
    session_id: string;
    device_id: string | null;
    device_label?: string | null;
    has_bytes?: boolean;
    bytes_generation?: number;
    updated_at?: number;
    title?: string;
    state?: string;
  }>) {
    return new Response(JSON.stringify({
      sessions: sessions.map((s) => ({
        session_id: s.session_id,
        device_id: s.device_id,
        device_label: s.device_label ?? null,
        agent: "claude-code",
        title: s.title ?? "remote session",
        state: s.state ?? "done",
        cwd: "/tmp/x",
        model: "claude-sonnet-4-6",
        started_at: "2026-05-11T10:00:00Z",
        ended_at: null,
        last_event_at: "2026-05-11T10:30:00Z",
        bytes_generation: s.bytes_generation ?? 0,
        has_bytes: s.has_bytes ?? false,
        updated_at: s.updated_at ?? 1000,
      })),
    }), { status: 200 });
  }

  it("no-op for free users", async () => {
    const { db, profileBinding } = harness();
    seedDevice(db);
    const fetchSpy = vi.fn(async () => cloudPayload([]));
    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "u1", email: "x@x", tier: "free" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect(await svc.pull()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("upserts foreign-device sessions and skips this device", async () => {
    const { db, profileBinding } = harness();
    profileBinding.bindToOwner("user-A");
    seedDevice(db, "dev-mac");
    const fetchSpy = vi.fn(async () =>
      cloudPayload([
        { session_id: "s-mine", device_id: "dev-mac", has_bytes: true },
        { session_id: "s-other", device_id: "dev-pc", has_bytes: true },
        { session_id: "s-orphan", device_id: null, has_bytes: false },
      ]),
    );
    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const applied = await svc.pull();
    // s-mine filtered out (own device); s-other + s-orphan upserted
    expect(applied).toBe(2);
    const rows = db.prepare(
      `SELECT session_id, has_bytes FROM remote_sessions WHERE owner_id = ? ORDER BY session_id`,
    ).all("user-A") as Array<{ session_id: string; has_bytes: number }>;
    expect(rows.map((r) => r.session_id)).toEqual(["s-orphan", "s-other"]);
    expect(rows.find((r) => r.session_id === "s-other")?.has_bytes).toBe(1);
    expect(rows.find((r) => r.session_id === "s-orphan")?.has_bytes).toBe(0);
  });

  it("populates remote_sessions.device_label from the cloud payload", async () => {
    // The cross-device session chip in the UI renders this label rather than
    // the opaque device_id UUID, so it has to flow through the pull path.
    const { db, profileBinding } = harness();
    profileBinding.bindToOwner("user-A");
    seedDevice(db, "dev-mac");
    const fetchSpy = vi.fn(async () =>
      cloudPayload([
        { session_id: "s-from-windows", device_id: "dev-pc", device_label: "DESKTOP-WIN", has_bytes: true },
        { session_id: "s-legacy", device_id: "dev-pc", device_label: null, has_bytes: true },
      ]),
    );
    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    await svc.pull();
    const rows = db.prepare(
      `SELECT session_id, device_label FROM remote_sessions WHERE owner_id = ? ORDER BY session_id`,
    ).all("user-A") as Array<{ session_id: string; device_label: string | null }>;
    expect(rows.find((r) => r.session_id === "s-from-windows")?.device_label).toBe("DESKTOP-WIN");
    expect(rows.find((r) => r.session_id === "s-legacy")?.device_label).toBeNull();
  });

  it("preserves an existing device_label when cloud later sends NULL (COALESCE)", async () => {
    // A subsequent pull where the origin device is offline or pushed a
    // partial-shape session must not erase the known label. The upsert's
    // COALESCE(excluded.device_label, ...) protects against that.
    const { db, profileBinding } = harness();
    profileBinding.bindToOwner("user-A");
    seedDevice(db, "dev-mac");
    let phase: "labelled" | "null" = "labelled";
    const fetchSpy = vi.fn(async () => {
      if (phase === "labelled") {
        return cloudPayload([
          { session_id: "s1", device_id: "dev-pc", device_label: "DESKTOP-WIN", updated_at: 1000 },
        ]);
      }
      return cloudPayload([
        { session_id: "s1", device_id: "dev-pc", device_label: null, updated_at: 2000 },
      ]);
    });
    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    await svc.pull();
    phase = "null";
    await svc.pull();
    const row = db.prepare(
      `SELECT device_label FROM remote_sessions WHERE session_id = 's1'`,
    ).get() as { device_label: string | null };
    expect(row.device_label).toBe("DESKTOP-WIN");
  });

  it("skips remote rows whose session_id already exists locally (legacy NULL device_id)", async () => {
    const { db, profileBinding } = harness();
    profileBinding.bindToOwner("user-A");
    seedDevice(db, "dev-mac");
    // Simulate the post-backfill state: local sessions table has a row for
    // "s-mine-legacy", and cloud has the same id but with NULL device_id
    // (pre-fix data). Without the local-id filter, this would round-trip
    // into remote_sessions as a ghost foreign row.
    db.prepare(
      `INSERT INTO sessions (id, agent, state, last_event_at, cloud_owner_id, sync_dirty_at)
       VALUES ('s-mine-legacy', 'claude-code', 'done', datetime('now'), 'user-A', 1000)`,
    ).run();
    const fetchSpy = vi.fn(async () =>
      cloudPayload([
        { session_id: "s-mine-legacy", device_id: null, has_bytes: true },
        { session_id: "s-other-pc", device_id: "dev-pc", has_bytes: true },
      ]),
    );
    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const applied = await svc.pull();
    expect(applied).toBe(1);  // only s-other-pc
    const rows = db.prepare(
      `SELECT session_id FROM remote_sessions WHERE owner_id = ?`,
    ).all("user-A") as Array<{ session_id: string }>;
    expect(rows.map((r) => r.session_id)).toEqual(["s-other-pc"]);
  });

  it("LWW: older cloud_updated_at does not overwrite newer local copy", async () => {
    const { db, profileBinding } = harness();
    profileBinding.bindToOwner("user-A");
    seedDevice(db, "dev-mac");
    let payload = cloudPayload([
      { session_id: "s-other", device_id: "dev-pc", title: "v2", updated_at: 5000 },
    ]);
    const fetchSpy = vi.fn(async () => payload);
    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    await svc.pull();
    // Now serve an OLDER updated_at — should NOT overwrite.
    payload = cloudPayload([
      { session_id: "s-other", device_id: "dev-pc", title: "v1-ancient", updated_at: 1000 },
    ]);
    await svc.pull();
    const row = db.prepare(
      `SELECT title FROM remote_sessions WHERE owner_id = ? AND session_id = ?`,
    ).get("user-A", "s-other") as { title: string };
    expect(row.title).toBe("v2");
  });

  it("reconcile calls pull and pushPending", async () => {
    const { db, profileBinding } = harness();
    profileBinding.bindToOwner("user-A");
    seedDevice(db);
    insertDirtySession(db, "s-dirty", "user-A", 1000);
    const fetchSpy = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/api/sessions/metadata") && !u.includes("?")) {
        // Could be GET (pull) or POST (push). Either way, return a valid shape.
        return new Response(JSON.stringify({ sessions: [], accepted: ["s-dirty"], rejected: [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    const svc = createSessionSyncService({
      db, profileBinding,
      currentUser: () => ({ id: "user-A", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const r = await svc.reconcile();
    expect(r.pulled).toBe(0);
    expect(r.pushed).toBe(1);
    // Both verbs were used
    const methods = fetchSpy.mock.calls.map((c) => (c[1] as RequestInit | undefined)?.method ?? "GET");
    expect(methods).toContain("GET");
    expect(methods).toContain("POST");
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

  it("uses jsonl_path even when cwd is a foreign path (cross-device resume case)", async () => {
    // Regression test for 0.8.1-beta.6 dogfooding bug: after Mac resumed a
    // Windows session, every event in the jsonl still carried
    // cwd: "C:\\Users\\matth", so the watcher couldn't recover the Mac cwd
    // from events. The fix is to store the actual on-disk jsonl path and
    // have pushBytes use it directly, ignoring sessions.cwd for file lookup.
    const root = setupBytesEnv();
    const { db, profileBinding } = harness();
    profileBinding.bindToOwner("user-A");
    // The file lives at the local Mac-encoded path...
    const realLocalDir = "-Users-me-Dev-oyster";
    mkdirSync(join(root, realLocalDir), { recursive: true });
    const jsonl = "{\"role\":\"user\",\"text\":\"hello from mac\"}\n";
    const realJsonlPath = join(root, realLocalDir, "s1.jsonl");
    writeFileSync(realJsonlPath, jsonl);
    // ...but sessions.cwd holds the origin (Windows) cwd. encodeCwd of that
    // would compute `/tmp/.../C--Users-matth/s1.jsonl`, which does not exist.
    // The new jsonl_path column is the truth.
    db.prepare(
      `INSERT INTO sessions (id, agent, state, last_event_at, cwd, jsonl_path, cloud_owner_id)
       VALUES ('s1', 'claude-code', 'active', datetime('now'),
               'C:\\Users\\matth', ?, 'user-A')`,
    ).run(realJsonlPath);

    const calls: Array<{ url: string; chunkNumber: number; body: Uint8Array }> = [];
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const m = u.match(/\/api\/sessions\/bytes\/([^/]+)\/chunk\/(\d+)$/);
      if (m && init?.method === "PUT") {
        const body = new Uint8Array(init.body as ArrayBuffer);
        calls.push({ url: u, chunkNumber: Number(m[2]), body });
        return new Response(JSON.stringify({ ok: true, chunk_number: 1, generation: 0 }), { status: 200 });
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
    expect(calls).toHaveLength(1);
    expect(new TextDecoder().decode(calls[0]!.body)).toBe(jsonl);
  });

  it("falls back to cwd-encoded path when jsonl_path is NULL (back-compat)", async () => {
    // Rows that pre-date the jsonl_path column (or that the watcher hasn't
    // re-touched yet) still resolve via the legacy `projectsRoot()/
    // encodeCwd(cwd)/<id>.jsonl` computation.
    const root = setupBytesEnv();
    const { db, profileBinding } = harness();
    profileBinding.bindToOwner("user-A");
    const cwd = "/tmp/proj-legacy";
    const encoded = cwd.replace(/[^A-Za-z0-9]/g, "-");
    mkdirSync(join(root, encoded), { recursive: true });
    writeFileSync(join(root, encoded, "s1.jsonl"), "legacy\n");
    db.prepare(
      `INSERT INTO sessions (id, agent, state, last_event_at, cwd, jsonl_path, cloud_owner_id)
       VALUES ('s1', 'claude-code', 'active', datetime('now'), ?, NULL, 'user-A')`,
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
    expect((await svc.pushBytes("s1")).uploaded).toBe(1);
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

