import type Database from "better-sqlite3";

export interface SpaceRow {
  id: string;
  display_name: string;
  repo_path: string | null;
  color: string | null;
  parent_id: string | null;
  scan_status: string;
  scan_error: string | null;
  last_scanned_at: string | null;
  last_scan_summary: string | null;
  ai_job_status: string | null;
  ai_job_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SpacePath {
  space_id: string;
  path: string;
  label: string | null;
  added_at: string;
}

export interface SpaceStore {
  getAll(): SpaceRow[];
  getById(id: string): SpaceRow | undefined;
  getByDisplayName(name: string): SpaceRow | undefined;
  getByRepoPath(repoPath: string): SpaceRow | undefined;
  insert(row: Omit<SpaceRow, "created_at" | "updated_at">): void;
  update(id: string, fields: Partial<Omit<SpaceRow, "id" | "created_at">>): void;
  delete(id: string): void;
  getPaths(spaceId: string): SpacePath[];
  addPath(spaceId: string, path: string, label?: string): void;
  removePath(spaceId: string, path: string): void;
  getSpaceByPath(path: string): SpaceRow | undefined;
}

export class SqliteSpaceStore implements SpaceStore {
  private stmts: {
    getAll: Database.Statement;
    getById: Database.Statement;
    getByDisplayName: Database.Statement;
    getByRepoPath: Database.Statement;
    insert: Database.Statement;
    getPaths: Database.Statement;
    addPath: Database.Statement;
    removePath: Database.Statement;
    getSpaceByPath: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      getAll: db.prepare("SELECT * FROM spaces ORDER BY display_name"),
      getById: db.prepare("SELECT * FROM spaces WHERE id = ?"),
      // Case-insensitive match; most recently updated wins when displayNames collide
      getByDisplayName: db.prepare("SELECT * FROM spaces WHERE LOWER(display_name) = LOWER(?) ORDER BY updated_at DESC LIMIT 1"),
      getByRepoPath: db.prepare("SELECT * FROM spaces WHERE repo_path = ?"),
      insert: db.prepare(`
        INSERT INTO spaces (
          id, display_name, repo_path, color, parent_id, scan_status,
          scan_error, last_scanned_at, last_scan_summary,
          ai_job_status, ai_job_error
        ) VALUES (
          @id, @display_name, @repo_path, @color, @parent_id, @scan_status,
          @scan_error, @last_scanned_at, @last_scan_summary,
          @ai_job_status, @ai_job_error
        )
      `),
      getPaths: db.prepare("SELECT * FROM space_paths WHERE space_id = ? ORDER BY added_at"),
      addPath: db.prepare("INSERT OR IGNORE INTO space_paths (space_id, path, label) VALUES (?, ?, ?)"),
      removePath: db.prepare("DELETE FROM space_paths WHERE space_id = ? AND path = ?"),
      getSpaceByPath: db.prepare("SELECT s.* FROM spaces s JOIN space_paths sp ON s.id = sp.space_id WHERE sp.path = ?"),
    };
  }

  getAll(): SpaceRow[] { return this.stmts.getAll.all() as SpaceRow[]; }
  getById(id: string): SpaceRow | undefined { return this.stmts.getById.get(id) as SpaceRow | undefined; }
  getByDisplayName(name: string): SpaceRow | undefined { return this.stmts.getByDisplayName.get(name) as SpaceRow | undefined; }
  getByRepoPath(repoPath: string): SpaceRow | undefined { return this.stmts.getByRepoPath.get(repoPath) as SpaceRow | undefined; }
  insert(row: Omit<SpaceRow, "created_at" | "updated_at">): void { this.stmts.insert.run(row); }
  delete(id: string): void {
    this.db.prepare("DELETE FROM space_paths WHERE space_id = ?").run(id);
    this.db.prepare("DELETE FROM spaces WHERE id = ?").run(id);
  }
  getPaths(spaceId: string): SpacePath[] { return this.stmts.getPaths.all(spaceId) as SpacePath[]; }
  addPath(spaceId: string, path: string, label?: string): void { this.stmts.addPath.run(spaceId, path, label ?? null); }
  removePath(spaceId: string, path: string): void { this.stmts.removePath.run(spaceId, path); }
  getSpaceByPath(path: string): SpaceRow | undefined { return this.stmts.getSpaceByPath.get(path) as SpaceRow | undefined; }

  private static readonly UPDATABLE_COLUMNS = new Set([
    "display_name", "repo_path", "color", "parent_id", "scan_status",
    "scan_error", "last_scanned_at", "last_scan_summary",
    "ai_job_status", "ai_job_error",
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
