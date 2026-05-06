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

export interface Source {
  id: string;
  space_id: string;
  type: "local_folder";
  path: string;
  label: string | null;
  added_at: string;
  removed_at: string | null;
}

export interface SpaceStore {
  getAll(): SpaceRow[];
  getById(id: string): SpaceRow | undefined;
  getByDisplayName(name: string): SpaceRow | undefined;
  insert(row: Omit<SpaceRow, "created_at" | "updated_at" | "sync_dirty_at" | "cloud_synced_at" | "deleted_at"> & { sync_dirty_at?: number | null; cloud_synced_at?: number | null; deleted_at?: number | null }): void;
  update(id: string, fields: Partial<Omit<SpaceRow, "id" | "created_at">>): void;
  delete(id: string): void;
  // sources
  addSource(args: { id: string; space_id: string; type: Source["type"]; path: string; label?: string | null }): void;
  softDeleteSource(sourceId: string): void;
  restoreSource(sourceId: string): void;
  getSources(spaceId: string, opts?: { includeRemoved?: boolean }): Source[];
  getSourceById(sourceId: string): Source | undefined;
  /** Batched lookup for callers that already know the set of ids they need (e.g. resolving sources for a page of artifacts). One SQL roundtrip via WHERE id IN (...). */
  getSourcesByIds(sourceIds: string[]): Source[];
  getActiveSourceByPath(path: string): Source | undefined;
  getSoftDeletedSourceByPathForSpace(spaceId: string, path: string): Source | undefined;
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
    addSource: Database.Statement;
    softDeleteSource: Database.Statement;
    restoreSource: Database.Statement;
    getSourcesActive: Database.Statement;
    getSourcesAll: Database.Statement;
    getSourceById: Database.Statement;
    getActiveSourceByPath: Database.Statement;
    getSoftDeletedSourceByPathForSpace: Database.Statement;
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
          ai_job_status, ai_job_error, summary_title, summary_content,
          sync_dirty_at, cloud_synced_at, deleted_at
        ) VALUES (
          @id, @display_name, @color, @parent_id, @scan_status,
          @scan_error, @last_scanned_at, @last_scan_summary,
          @ai_job_status, @ai_job_error, @summary_title, @summary_content,
          @sync_dirty_at, @cloud_synced_at, @deleted_at
        )
      `),
      addSource: db.prepare(`
        INSERT INTO sources (id, space_id, type, path, label)
        VALUES (?, ?, ?, ?, ?)
      `),
      softDeleteSource: db.prepare("UPDATE sources SET removed_at = datetime('now') WHERE id = ? AND removed_at IS NULL"),
      restoreSource: db.prepare("UPDATE sources SET removed_at = NULL WHERE id = ?"),
      getSourcesActive: db.prepare("SELECT * FROM sources WHERE space_id = ? AND removed_at IS NULL ORDER BY added_at"),
      getSourcesAll: db.prepare("SELECT * FROM sources WHERE space_id = ? ORDER BY added_at"),
      getSourceById: db.prepare("SELECT * FROM sources WHERE id = ?"),
      getActiveSourceByPath: db.prepare("SELECT * FROM sources WHERE path = ? AND removed_at IS NULL"),
      getSoftDeletedSourceByPathForSpace: db.prepare(
        "SELECT * FROM sources WHERE space_id = ? AND path = ? AND removed_at IS NOT NULL ORDER BY added_at DESC LIMIT 1"
      ),
    };
  }

  getAll(): SpaceRow[] { return this.stmts.getAll.all() as SpaceRow[]; }
  getById(id: string): SpaceRow | undefined { return this.stmts.getById.get(id) as SpaceRow | undefined; }
  getByDisplayName(name: string): SpaceRow | undefined { return this.stmts.getByDisplayName.get(name) as SpaceRow | undefined; }
  insert(row: Omit<SpaceRow, "created_at" | "updated_at">): void {
    this.stmts.insert.run({
      sync_dirty_at: null, cloud_synced_at: null, deleted_at: null,
      ...row,
    });
  }
  delete(id: string): void {
    // Cascade: sources.space_id ON DELETE CASCADE → sources rows hard-deleted,
    // which fires artifacts.source_id ON DELETE SET NULL on their artifacts.
    this.db.prepare("DELETE FROM space_paths WHERE space_id = ?").run(id);
    this.db.prepare("DELETE FROM spaces WHERE id = ?").run(id);
  }

  addSource(args: { id: string; space_id: string; type: Source["type"]; path: string; label?: string | null }): void {
    this.stmts.addSource.run(args.id, args.space_id, args.type, args.path, args.label ?? null);
  }
  softDeleteSource(sourceId: string): void { this.stmts.softDeleteSource.run(sourceId); }
  restoreSource(sourceId: string): void { this.stmts.restoreSource.run(sourceId); }
  getSources(spaceId: string, opts?: { includeRemoved?: boolean }): Source[] {
    const stmt = opts?.includeRemoved ? this.stmts.getSourcesAll : this.stmts.getSourcesActive;
    return stmt.all(spaceId) as Source[];
  }
  getSourceById(sourceId: string): Source | undefined { return this.stmts.getSourceById.get(sourceId) as Source | undefined; }
  getSourcesByIds(sourceIds: string[]): Source[] {
    if (sourceIds.length === 0) return [];
    // Dynamic placeholder list — better-sqlite3 has no native array binding,
    // and we'd rather one prepared statement per call than N getById hits.
    const placeholders = sourceIds.map(() => "?").join(",");
    return this.db.prepare(`SELECT * FROM sources WHERE id IN (${placeholders})`).all(...sourceIds) as Source[];
  }
  getActiveSourceByPath(path: string): Source | undefined { return this.stmts.getActiveSourceByPath.get(path) as Source | undefined; }
  getSoftDeletedSourceByPathForSpace(spaceId: string, path: string): Source | undefined {
    return this.stmts.getSoftDeletedSourceByPathForSpace.get(spaceId, path) as Source | undefined;
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
    this.db.prepare(
      "UPDATE spaces SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
    ).run(deletedAt, id);
  }

  markSyncDirty(id: string, dirtyAt: number = Date.now()): void {
    // Unconditional set — the caller's timestamp is the right one. (We don't
    // guard MAX(existing, dirtyAt) because mutations always represent the
    // user's most recent intent; a stale write would be a bug.)
    this.db.prepare(
      "UPDATE spaces SET sync_dirty_at = ? WHERE id = ?",
    ).run(dirtyAt, id);
  }

  getDirtyRows(): SpaceRow[] {
    return this.db.prepare(`
      SELECT * FROM spaces
       WHERE deleted_at IS NULL
         AND sync_dirty_at IS NOT NULL
         AND (cloud_synced_at IS NULL OR sync_dirty_at > cloud_synced_at)
    `).all() as SpaceRow[];
  }

  getPendingDeletes(): SpaceRow[] {
    return this.db.prepare(`
      SELECT * FROM spaces
       WHERE deleted_at IS NOT NULL
         AND (cloud_synced_at IS NULL OR deleted_at > cloud_synced_at)
    `).all() as SpaceRow[];
  }

  markSynced(id: string, cloudUpdatedAt: number): void {
    this.db.prepare(
      "UPDATE spaces SET cloud_synced_at = ? WHERE id = ?",
    ).run(cloudUpdatedAt, id);
  }

  getAllIncludingDeleted(): SpaceRow[] {
    return this.db.prepare("SELECT * FROM spaces ORDER BY display_name").all() as SpaceRow[];
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
