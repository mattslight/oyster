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
      id              TEXT PRIMARY KEY,
      space_id        TEXT,
      agent           TEXT NOT NULL,
      title           TEXT,
      state           TEXT NOT NULL,
      started_at      TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at        TEXT,
      model           TEXT,
      last_event_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_offset     INTEGER NOT NULL DEFAULT 0,
      source_id       TEXT,
      cwd             TEXT,
      sync_dirty_at   INTEGER,
      cloud_synced_at INTEGER,
      cloud_owner_id  TEXT,
      jsonl_synced_at INTEGER,
      jsonl_snapshot_offset INTEGER
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
