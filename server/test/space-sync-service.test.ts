import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { SqliteSpaceStore } from "../src/space-store.js";
import { createSpaceSyncService } from "../src/space-sync-service.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE spaces (
      id                TEXT PRIMARY KEY,
      display_name      TEXT NOT NULL,
      color             TEXT,
      parent_id         TEXT,
      scan_status       TEXT NOT NULL DEFAULT 'none',
      scan_error        TEXT,
      last_scanned_at   TEXT,
      last_scan_summary TEXT,
      ai_job_status     TEXT,
      ai_job_error      TEXT,
      summary_title     TEXT,
      summary_content   TEXT,
      sync_dirty_at     INTEGER,
      cloud_synced_at   INTEGER,
      deleted_at        INTEGER,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE space_paths (
      space_id TEXT NOT NULL, path TEXT NOT NULL, label TEXT,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (space_id, path)
    );
    CREATE TABLE sources (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL,
      type TEXT NOT NULL, path TEXT NOT NULL,
      label TEXT, added_at TEXT NOT NULL DEFAULT (datetime('now')),
      removed_at TEXT
    );
  `);
  return db;
}

function insertRow(
  store: SqliteSpaceStore,
  id: string,
  opts: Partial<{ displayName: string; color: string; parentId: string; summaryTitle: string; summaryContent: string }> = {},
) {
  store.insert({
    id,
    display_name: opts.displayName ?? id,
    color: opts.color ?? null,
    parent_id: opts.parentId ?? null,
    scan_status: "none", scan_error: null, last_scanned_at: null,
    last_scan_summary: null, ai_job_status: null, ai_job_error: null,
    summary_title: opts.summaryTitle ?? null,
    summary_content: opts.summaryContent ?? null,
  });
}

const FREE_USER  = { id: "u1", email: "a@a", tier: "free" };
const PRO_USER   = { id: "u1", email: "a@a", tier: "pro" };

describe("createSpaceSyncService — reconcile()", () => {
  let db: Database.Database;
  let store: SqliteSpaceStore;

  beforeEach(() => {
    db = makeDb();
    store = new SqliteSpaceStore(db);
    vi.restoreAllMocks();
  });

  it("returns zeros when no signed-in user (no network call)", async () => {
    const fetchMock = vi.fn();
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => null,
      sessionToken: () => null,
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await svc.reconcile();
    expect(result).toEqual({ pulled: 0, pushed: 0, tombstoned: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns zeros for free-tier users (sync is Pro-only — no network call)", async () => {
    insertRow(store, "work");
    store.markSyncDirty("work", 1000);
    const fetchMock = vi.fn();
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => FREE_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await svc.reconcile();
    expect(result).toEqual({ pulled: 0, pushed: 0, tombstoned: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pulls cloud rows that don't exist locally and inserts them", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/spaces/mine")) {
        return new Response(JSON.stringify({
          spaces: [{
            owner_id: "u1", space_id: "from-cloud", display_name: "From Cloud",
            color: "#3d8aaa", parent_id: null,
            summary_title: null, summary_content: null,
            updated_at: 5000, deleted_at: null, created_at: 5000,
          }],
        }), { status: 200 });
      }
      throw new Error("unexpected fetch: " + url);
    });
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await svc.reconcile();
    expect(result.pulled).toBe(1);
    const row = store.getById("from-cloud")!;
    expect(row.display_name).toBe("From Cloud");
    expect((row as { cloud_synced_at: number | null }).cloud_synced_at).toBe(5000);
  });

  it("updates a local row when cloud.updated_at > local.sync_dirty_at (cloud wins)", async () => {
    insertRow(store, "work", { displayName: "Old Name" });
    store.markSyncDirty("work", 1000);
    store.markSynced("work", 1000);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/spaces/mine")) {
        return new Response(JSON.stringify({
          spaces: [{
            owner_id: "u1", space_id: "work", display_name: "New Name",
            color: null, parent_id: null,
            summary_title: null, summary_content: null,
            updated_at: 9999, deleted_at: null, created_at: 1000,
          }],
        }), { status: 200 });
      }
      throw new Error("unexpected fetch: " + url);
    });
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.reconcile();
    const row = store.getById("work")!;
    expect(row.display_name).toBe("New Name");
    expect((row as { cloud_synced_at: number | null }).cloud_synced_at).toBe(9999);
  });

  it("does NOT pull when local.sync_dirty_at > cloud.updated_at (local wins, will push)", async () => {
    insertRow(store, "work", { displayName: "Local Edit" });
    store.markSyncDirty("work", 9999);
    store.markSynced("work", 1000);

    const puts: Array<{ url: string; body: any }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/spaces/mine")) {
        return new Response(JSON.stringify({
          spaces: [{
            owner_id: "u1", space_id: "work", display_name: "Stale Cloud",
            color: null, parent_id: null,
            summary_title: null, summary_content: null,
            updated_at: 5000, deleted_at: null, created_at: 1000,
          }],
        }), { status: 200 });
      }
      if (url.includes("/api/spaces/work") && init?.method === "PUT") {
        puts.push({ url, body: JSON.parse(init.body as string) });
        return new Response(JSON.stringify({
          space: {
            owner_id: "u1", space_id: "work", display_name: "Local Edit",
            color: null, parent_id: null,
            summary_title: null, summary_content: null,
            updated_at: 9999, deleted_at: null, created_at: 1000,
          },
        }), { status: 200 });
      }
      throw new Error("unexpected fetch: " + url);
    });
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await svc.reconcile();
    expect(result.pulled).toBe(0);
    expect(result.pushed).toBe(1);
    expect(puts[0]!.body.updated_at).toBe(9999);   // wire ts = sync_dirty_at
    expect(store.getById("work")!.display_name).toBe("Local Edit");  // local preserved
  });

  it("soft-deletes a local row when cloud row carries deleted_at, preserving cloud's deleted_at timestamp", async () => {
    insertRow(store, "work");

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/spaces/mine")) {
        return new Response(JSON.stringify({
          spaces: [{
            owner_id: "u1", space_id: "work", display_name: "Work",
            color: null, parent_id: null,
            summary_title: null, summary_content: null,
            updated_at: 9000, deleted_at: 9000, created_at: 1000,
          }],
        }), { status: 200 });
      }
      throw new Error("unexpected fetch: " + url);
    });
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await svc.reconcile();
    expect(result.tombstoned).toBe(1);
    expect(store.getById("work")).toBeUndefined();
    const raw = db.prepare("SELECT deleted_at, cloud_synced_at FROM spaces WHERE id = 'work'")
      .get() as { deleted_at: number; cloud_synced_at: number };
    expect(raw.deleted_at).toBe(9000);              // cloud's tombstone preserved
    expect(raw.cloud_synced_at).toBe(9000);         // marked synced
  });

  it("pushes dirty rows to PUT /api/spaces/:id with sync_dirty_at as wire updated_at", async () => {
    insertRow(store, "work", { displayName: "Work" });
    store.markSyncDirty("work", 7000);

    const puts: Array<{ url: string; body: any }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/spaces/mine")) {
        return new Response(JSON.stringify({ spaces: [] }), { status: 200 });
      }
      if (url.includes("/api/spaces/work") && init?.method === "PUT") {
        puts.push({ url, body: JSON.parse(init.body as string) });
        return new Response(JSON.stringify({
          space: {
            owner_id: "u1", space_id: "work", display_name: "Work",
            color: null, parent_id: null,
            summary_title: null, summary_content: null,
            updated_at: 7000, deleted_at: null, created_at: 7000,
          },
        }), { status: 200 });
      }
      throw new Error("unexpected fetch: " + url);
    });
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await svc.reconcile();
    expect(result.pushed).toBe(1);
    expect(puts[0]!.body.updated_at).toBe(7000);
    const row = store.getById("work")!;
    expect((row as { cloud_synced_at: number | null }).cloud_synced_at).toBe(7000);
  });

  it("pushes pending deletes via DELETE /api/spaces/:id and marks them synced", async () => {
    insertRow(store, "work");
    store.softDelete("work", 8000);

    const deletes: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/spaces/mine")) {
        return new Response(JSON.stringify({ spaces: [] }), { status: 200 });
      }
      if (url.includes("/api/spaces/work") && init?.method === "DELETE") {
        deletes.push(url);
        return new Response(JSON.stringify({
          space_id: "work", deleted_at: 8000, updated_at: 8000,
        }), { status: 200 });
      }
      throw new Error("unexpected fetch: " + url);
    });
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.reconcile();
    expect(deletes).toHaveLength(1);
    const raw = db.prepare("SELECT cloud_synced_at FROM spaces WHERE id = 'work'")
      .get() as { cloud_synced_at: number };
    expect(raw.cloud_synced_at).toBe(8000);
    // Pending-delete predicate is now false → next reconcile won't re-push.
    expect(store.getPendingDeletes()).toEqual([]);
  });

  it("treats DELETE 404 as 'already gone elsewhere' and marks the local tombstone synced", async () => {
    insertRow(store, "work");
    store.softDelete("work", 8000);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/spaces/mine")) {
        return new Response(JSON.stringify({ spaces: [] }), { status: 200 });
      }
      if (url.includes("/api/spaces/work") && init?.method === "DELETE") {
        return new Response(JSON.stringify({ error: "space_not_found" }), { status: 404 });
      }
      throw new Error("unexpected fetch: " + url);
    });
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.reconcile();
    const raw = db.prepare("SELECT cloud_synced_at FROM spaces WHERE id = 'work'")
      .get() as { cloud_synced_at: number };
    expect(raw.cloud_synced_at).toBe(8000);  // local deleted_at acknowledged
    expect(store.getPendingDeletes()).toEqual([]);
  });

  it("is idempotent — back-to-back reconciles with no mutations report 0/0/0", async () => {
    insertRow(store, "work");
    store.markSyncDirty("work", 5000);
    store.markSynced("work", 5000);

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ spaces: [] }), { status: 200 }));
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const first = await svc.reconcile();
    const second = await svc.reconcile();
    expect(first).toEqual({ pulled: 0, pushed: 0, tombstoned: 0 });
    expect(second).toEqual({ pulled: 0, pushed: 0, tombstoned: 0 });
  });
});

describe("createSpaceSyncService — pushOne()", () => {
  let db: Database.Database;
  let store: SqliteSpaceStore;

  beforeEach(() => {
    db = makeDb();
    store = new SqliteSpaceStore(db);
    vi.restoreAllMocks();
  });

  it("does nothing when user is signed out", async () => {
    insertRow(store, "work");
    store.markSyncDirty("work", 1000);
    const fetchMock = vi.fn();
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => null,
      sessionToken: () => null,
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushOne("work");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing for free-tier users (Pro-only feature)", async () => {
    insertRow(store, "work");
    store.markSyncDirty("work", 1000);
    const fetchMock = vi.fn();
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => FREE_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushOne("work");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when row is missing", async () => {
    const fetchMock = vi.fn();
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushOne("ghost");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when row has no sync_dirty_at (no sync-relevant change)", async () => {
    insertRow(store, "work");
    // No markSyncDirty — row was inserted but not flagged for sync.
    const fetchMock = vi.fn();
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushOne("work");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when row is already clean (cloud_synced_at >= sync_dirty_at)", async () => {
    insertRow(store, "work");
    store.markSyncDirty("work", 1000);
    store.markSynced("work", 1000);
    const fetchMock = vi.fn();
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushOne("work");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PUTs a dirty row with sync_dirty_at as wire updated_at, updates cloud_synced_at on 200", async () => {
    insertRow(store, "work");
    store.markSyncDirty("work", 6000);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      const body = JSON.parse(init!.body as string) as { updated_at: number };
      expect(body.updated_at).toBe(6000);
      return new Response(JSON.stringify({
        space: {
          owner_id: "u1", space_id: "work", display_name: "work",
          color: null, parent_id: null,
          summary_title: null, summary_content: null,
          updated_at: 6000, deleted_at: null, created_at: 6000,
        },
      }), { status: 200 });
    });
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushOne("work");
    expect(fetchMock).toHaveBeenCalledOnce();
    const row = store.getById("work")!;
    expect((row as { cloud_synced_at: number | null }).cloud_synced_at).toBe(6000);
  });

  it("on 410, soft-deletes the local row (deletion wins over stale rename)", async () => {
    insertRow(store, "work");
    store.markSyncDirty("work", 1000);
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: "space_tombstoned" }), { status: 410 },
    ));
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushOne("work");
    expect(store.getById("work")).toBeUndefined();
  });

  it("swallows network errors (console.warn, no throw)", async () => {
    insertRow(store, "work");
    store.markSyncDirty("work", 1000);
    const fetchMock = vi.fn(async () => { throw new Error("offline"); });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(svc.pushOne("work")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});
