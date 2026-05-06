import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SqliteSpaceStore } from "../src/space-store.js";

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

function insertRow(store: SqliteSpaceStore, id: string, opts: Partial<{ displayName: string }> = {}) {
  store.insert({
    id, display_name: opts.displayName ?? id, color: null, parent_id: null,
    scan_status: "none", scan_error: null, last_scanned_at: null,
    last_scan_summary: null, ai_job_status: null, ai_job_error: null,
    summary_title: null, summary_content: null,
  });
}

describe("SqliteSpaceStore — sync methods + soft-delete", () => {
  let db: Database.Database;
  let store: SqliteSpaceStore;

  beforeEach(() => {
    db = makeDb();
    store = new SqliteSpaceStore(db);
  });

  describe("markSyncDirty", () => {
    it("sets sync_dirty_at to the given timestamp", () => {
      insertRow(store, "a");
      store.markSyncDirty("a", 1234);
      const row = db.prepare("SELECT sync_dirty_at FROM spaces WHERE id='a'")
        .get() as { sync_dirty_at: number };
      expect(row.sync_dirty_at).toBe(1234);
    });

    it("defaults to Date.now() when no timestamp is given", () => {
      insertRow(store, "a");
      const before = Date.now();
      store.markSyncDirty("a");
      const after = Date.now();
      const row = db.prepare("SELECT sync_dirty_at FROM spaces WHERE id='a'")
        .get() as { sync_dirty_at: number };
      expect(row.sync_dirty_at).toBeGreaterThanOrEqual(before);
      expect(row.sync_dirty_at).toBeLessThanOrEqual(after);
    });
  });

  describe("getDirtyRows", () => {
    it("excludes rows where sync_dirty_at IS NULL (no sync-relevant change yet)", () => {
      insertRow(store, "a");
      // No markSyncDirty call → row is not dirty per the new predicate.
      expect(store.getDirtyRows()).toEqual([]);
    });

    it("returns rows where sync_dirty_at IS NOT NULL AND cloud_synced_at IS NULL", () => {
      insertRow(store, "a");
      insertRow(store, "b");
      store.markSyncDirty("a", 1000);
      store.markSyncDirty("b", 2000);
      expect(store.getDirtyRows().map(r => r.id).sort()).toEqual(["a", "b"]);
    });

    it("returns rows where sync_dirty_at > cloud_synced_at", () => {
      insertRow(store, "a");
      store.markSyncDirty("a", 5000);
      store.markSynced("a", 3000);  // synced state from before this dirty mark
      expect(store.getDirtyRows().map(r => r.id)).toEqual(["a"]);
    });

    it("excludes rows where cloud_synced_at >= sync_dirty_at", () => {
      insertRow(store, "a");
      store.markSyncDirty("a", 1000);
      store.markSynced("a", 1000);
      expect(store.getDirtyRows()).toEqual([]);
    });

    it("excludes tombstoned rows (those go via getPendingDeletes)", () => {
      insertRow(store, "a");
      store.markSyncDirty("a", 1000);
      store.softDelete("a");
      expect(store.getDirtyRows().map(r => r.id)).toEqual([]);
    });
  });

  describe("getPendingDeletes", () => {
    it("returns soft-deleted rows whose deleted_at is unsynced", () => {
      insertRow(store, "a");
      store.softDelete("a", 5000);
      const pending = store.getPendingDeletes();
      expect(pending.map(r => r.id)).toEqual(["a"]);
    });

    it("excludes soft-deleted rows already synced past their deleted_at", () => {
      insertRow(store, "a");
      store.softDelete("a", 5000);
      store.markSynced("a", 5000);
      expect(store.getPendingDeletes()).toEqual([]);
    });

    it("includes soft-deleted rows where cloud_synced_at < deleted_at (peer state stale)", () => {
      insertRow(store, "a");
      store.markSynced("a", 1000);
      store.softDelete("a", 5000);
      expect(store.getPendingDeletes().map(r => r.id)).toEqual(["a"]);
    });

    it("excludes live rows", () => {
      insertRow(store, "a");
      store.markSyncDirty("a", 1000);
      expect(store.getPendingDeletes()).toEqual([]);
    });
  });

  describe("markSynced", () => {
    it("sets cloud_synced_at to the given timestamp", () => {
      insertRow(store, "a");
      store.markSynced("a", 9999);
      const row = store.getById("a")!;
      expect((row as { cloud_synced_at: number | null }).cloud_synced_at).toBe(9999);
    });
  });

  describe("softDelete", () => {
    it("sets deleted_at to now() by default", () => {
      insertRow(store, "a");
      const before = Date.now();
      store.softDelete("a");
      const row = db.prepare("SELECT deleted_at FROM spaces WHERE id = 'a'")
        .get() as { deleted_at: number };
      expect(row.deleted_at).toBeGreaterThanOrEqual(before);
    });

    it("uses the provided deletedAt timestamp when given (preserves cross-device tombstone provenance)", () => {
      insertRow(store, "a");
      store.softDelete("a", 12345);
      const row = db.prepare("SELECT deleted_at FROM spaces WHERE id = 'a'")
        .get() as { deleted_at: number };
      expect(row.deleted_at).toBe(12345);
    });

    it("excludes the soft-deleted row from getAll() and getById()", () => {
      insertRow(store, "a"); insertRow(store, "b");
      store.softDelete("a");
      expect(store.getAll().map(r => r.id)).toEqual(["b"]);
      expect(store.getById("a")).toBeUndefined();
    });

    it("is idempotent — re-softDelete leaves deleted_at unchanged", () => {
      insertRow(store, "a");
      store.softDelete("a", 5000);
      store.softDelete("a", 9999);  // attempts to overwrite
      const row = db.prepare("SELECT deleted_at FROM spaces WHERE id='a'")
        .get() as { deleted_at: number };
      expect(row.deleted_at).toBe(5000);
    });
  });

  describe("getAllIncludingDeleted", () => {
    it("includes tombstoned rows", () => {
      insertRow(store, "a"); insertRow(store, "b");
      store.softDelete("a");
      expect(store.getAllIncludingDeleted().map(r => r.id).sort()).toEqual(["a", "b"]);
    });
  });

  describe("delete (hard delete — kept for failed-promotion cleanup)", () => {
    it("getAll still excludes hard-deleted rows", () => {
      insertRow(store, "a");
      store.delete("a");
      expect(store.getAll()).toEqual([]);
    });
  });
});
