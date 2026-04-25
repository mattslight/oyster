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
  insert(row: Omit<SpaceRow, "created_at" | "updated_at">): void;
  update(id: string, fields: Partial<Omit<SpaceRow, "id" | "created_at">>): void;
  delete(id: string): void;
  // sources
  addSource(args: { id: string; space_id: string; type: Source["type"]; path: string; label?: string | null }): void;
  softDeleteSource(sourceId: string): void;
  restoreSource(sourceId: string): void;
  getSources(spaceId: string, opts?: { includeRemoved?: boolean }): Source[];
  getSourceById(sourceId: string): Source | undefined;
  getActiveSourceByPath(path: string): Source | undefined;
  getSoftDeletedSourceByPathForSpace(spaceId: string, path: string): Source | undefined;
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
      getAll: db.prepare("SELECT * FROM spaces ORDER BY display_name"),
      getById: db.prepare("SELECT * FROM spaces WHERE id = ?"),
      // Case-insensitive + trim-tolerant match; most recently updated wins when displayNames collide
      getByDisplayName: db.prepare("SELECT * FROM spaces WHERE LOWER(TRIM(display_name)) = LOWER(TRIM(?)) ORDER BY updated_at DESC LIMIT 1"),
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
  insert(row: Omit<SpaceRow, "created_at" | "updated_at">): void { this.stmts.insert.run(row); }
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
  getActiveSourceByPath(path: string): Source | undefined { return this.stmts.getActiveSourceByPath.get(path) as Source | undefined; }
  getSoftDeletedSourceByPathForSpace(spaceId: string, path: string): Source | undefined {
    return this.stmts.getSoftDeletedSourceByPathForSpace.get(spaceId, path) as Source | undefined;
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
