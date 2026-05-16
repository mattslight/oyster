import type Database from "better-sqlite3";

export interface SpaceRow {
  id: string;
  display_name: string;
  color: string | null;
  parent_id: string | null;
  scan_status: string;
  scan_error: string | null;
  last_scanned_at: string | null;
  last_scan_summary: string | null;
  ai_job_status: string | null;
  ai_job_error: string | null;
  summary_title: string | null;
  summary_content: string | null;
  sync_dirty_at: number | null;
  cloud_synced_at: number | null;
  deleted_at: number | null;
  created_at: string;
  updated_at: string;
}

export interface SpaceStore {
  getAll(): SpaceRow[];
  getById(id: string): SpaceRow | undefined;
  getByDisplayName(name: string): SpaceRow | undefined;
  insert(row: Omit<SpaceRow, "created_at" | "updated_at" | "sync_dirty_at" | "cloud_synced_at" | "deleted_at">): void;
  update(id: string, fields: Partial<Omit<SpaceRow, "id" | "created_at">>): void;
  delete(id: string): void;
  /** Soft-delete a space. Sets deleted_at to the provided timestamp (or
   *  Date.now()). Idempotent — re-call on an already-deleted row is a no-op
   *  (preserves the original deleted_at). When applying a cross-device
   *  tombstone, pass the cloud's deleted_at to preserve provenance. */
  softDelete(id: string, deletedAt?: number): void;
  /** Mark a row as having a sync-relevant change pending push. Bumped only
   *  by mutations that change synced fields (display_name, color, parent_id,
   *  summary_title, summary_content). NOT bumped by scanner/local-only
   *  mutations — so a scanner pass can't stomp a peer's rename via LWW. */
  markSyncDirty(id: string, dirtyAt?: number): void;
  /** Live rows with pending pushes. Predicate:
   *    deleted_at IS NULL
   *    AND sync_dirty_at IS NOT NULL
   *    AND (cloud_synced_at IS NULL OR sync_dirty_at > cloud_synced_at) */
  getDirtyRows(): SpaceRow[];
  /** Tombstoned rows whose deletion hasn't been confirmed by the cloud.
   *  Predicate:
   *    deleted_at IS NOT NULL
   *    AND (cloud_synced_at IS NULL OR deleted_at > cloud_synced_at) */
  getPendingDeletes(): SpaceRow[];
  /** Mark a row as synced through to the cloud at `cloudUpdatedAt`. For live
   *  rows this is the cloud's updated_at; for confirmed deletes, the cloud's
   *  deleted_at (or 404-acknowledged local deleted_at). */
  markSynced(id: string, cloudUpdatedAt: number): void;
  /** All rows including tombstones. Sync only — surface always uses getAll. */
  getAllIncludingDeleted(): SpaceRow[];
  // Run a closure inside a SAVEPOINT-backed transaction. better-sqlite3
  // rolls back the SQL writes if the closure throws. (JS state mutations
  // inside the closure don't roll back — that's the caller's problem.)
  transaction<T>(fn: () => T): T;
}

export class SqliteSpaceStore implements SpaceStore {
  private stmts: {
    getAll: Database.Statement;
    getById: Database.Statement;
    getByDisplayName: Database.Statement;
    insert: Database.Statement;
    softDelete: Database.Statement;
    markSyncDirty: Database.Statement;
    getDirtyRows: Database.Statement;
    getPendingDeletes: Database.Statement;
    markSynced: Database.Statement;
    getAllIncludingDeleted: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      getAll: db.prepare("SELECT * FROM spaces WHERE deleted_at IS NULL ORDER BY display_name"),
      getById: db.prepare("SELECT * FROM spaces WHERE id = ? AND deleted_at IS NULL"),
      // Case-insensitive + trim-tolerant match; most recently updated wins when displayNames collide
      getByDisplayName: db.prepare("SELECT * FROM spaces WHERE LOWER(TRIM(display_name)) = LOWER(TRIM(?)) AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1"),
      insert: db.prepare(`
        INSERT INTO spaces (
          id, display_name, color, parent_id, scan_status,
          scan_error, last_scanned_at, last_scan_summary,
          ai_job_status, ai_job_error, summary_title, summary_content
        ) VALUES (
          @id, @display_name, @color, @parent_id, @scan_status,
          @scan_error, @last_scanned_at, @last_scan_summary,
          @ai_job_status, @ai_job_error, @summary_title, @summary_content
        )
      `),
      softDelete: db.prepare("UPDATE spaces SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL"),
      markSyncDirty: db.prepare("UPDATE spaces SET sync_dirty_at = ? WHERE id = ?"),
      getDirtyRows: db.prepare(`
        SELECT * FROM spaces
         WHERE deleted_at IS NULL
           AND sync_dirty_at IS NOT NULL
           AND (cloud_synced_at IS NULL OR sync_dirty_at > cloud_synced_at)
      `),
      getPendingDeletes: db.prepare(`
        SELECT * FROM spaces
         WHERE deleted_at IS NOT NULL
           AND (cloud_synced_at IS NULL OR deleted_at > cloud_synced_at)
      `),
      markSynced: db.prepare("UPDATE spaces SET cloud_synced_at = ? WHERE id = ?"),
      getAllIncludingDeleted: db.prepare("SELECT * FROM spaces ORDER BY display_name"),
    };
  }

  getAll(): SpaceRow[] { return this.stmts.getAll.all() as SpaceRow[]; }
  getById(id: string): SpaceRow | undefined { return this.stmts.getById.get(id) as SpaceRow | undefined; }
  getByDisplayName(name: string): SpaceRow | undefined { return this.stmts.getByDisplayName.get(name) as SpaceRow | undefined; }
  insert(row: Omit<SpaceRow, "created_at" | "updated_at" | "sync_dirty_at" | "cloud_synced_at" | "deleted_at">): void {
    this.stmts.insert.run(row);
  }
  delete(id: string): void {
    this.db.prepare("DELETE FROM space_paths WHERE space_id = ?").run(id);
    this.db.prepare("DELETE FROM spaces WHERE id = ?").run(id);
  }

  transaction<T>(fn: () => T): T {
    const result = this.db.transaction(fn)();
    // Guard against async fns: better-sqlite3's transaction is synchronous,
    // so an async closure would resolve AFTER commit — rejections inside the
    // Promise would never roll back the transaction. Better to fail loudly.
    if (result instanceof Promise) {
      throw new Error("spaceStore.transaction(fn): fn must be synchronous (got a Promise)");
    }
    return result;
  }

  softDelete(id: string, deletedAt: number = Date.now()): void {
    // Unix ms throughout so the dirty/pending-delete predicates and the
    // cloud column are uniformly comparable. The IS NULL guard makes this
    // idempotent (re-call preserves the original tombstone timestamp).
    this.stmts.softDelete.run(deletedAt, id);
  }

  markSyncDirty(id: string, dirtyAt: number = Date.now()): void {
    // Unconditional set — the caller's timestamp is the right one. (We don't
    // guard MAX(existing, dirtyAt) because mutations always represent the
    // user's most recent intent; a stale write would be a bug.)
    this.stmts.markSyncDirty.run(dirtyAt, id);
  }

  getDirtyRows(): SpaceRow[] {
    return this.stmts.getDirtyRows.all() as SpaceRow[];
  }

  getPendingDeletes(): SpaceRow[] {
    return this.stmts.getPendingDeletes.all() as SpaceRow[];
  }

  markSynced(id: string, cloudUpdatedAt: number): void {
    this.stmts.markSynced.run(cloudUpdatedAt, id);
  }

  getAllIncludingDeleted(): SpaceRow[] {
    return this.stmts.getAllIncludingDeleted.all() as SpaceRow[];
  }

  private static readonly UPDATABLE_COLUMNS = new Set([
    "display_name", "color", "parent_id", "scan_status",
    "scan_error", "last_scanned_at", "last_scan_summary",
    "ai_job_status", "ai_job_error", "summary_title", "summary_content",
  ]);

  update(id: string, fields: Partial<Omit<SpaceRow, "id" | "created_at">>): void {
    const sets: string[] = [];
    const values: Record<string, unknown> = { id };
    for (const [key, value] of Object.entries(fields)) {
      if (!SqliteSpaceStore.UPDATABLE_COLUMNS.has(key)) continue;
      sets.push(`${key} = @${key}`);
      values[key] = value;
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    this.db.prepare(`UPDATE spaces SET ${sets.join(", ")} WHERE id = @id`).run(values);
  }
}
