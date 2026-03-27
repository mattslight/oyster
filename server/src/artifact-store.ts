import type Database from "better-sqlite3";

// ── Row type (mirrors SQLite schema) ──

export interface ArtifactRow {
  id: string;
  owner_id: string | null;
  space_id: string;
  label: string;
  artifact_kind: string;
  storage_kind: string;
  storage_config: string;
  runtime_kind: string;
  runtime_config: string;
  group_name: string | null;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Store interface ──

export type InsertRow = Omit<ArtifactRow, "created_at" | "updated_at">;

export interface ArtifactStore {
  getAll(): ArtifactRow[];
  getById(id: string): ArtifactRow | undefined;
  getBySpaceId(spaceId: string): ArtifactRow[];
  getByPath(absPath: string): ArtifactRow | undefined;
  getDistinctSpaces(): { space_id: string; count: number }[];
  insert(row: InsertRow): void;
  update(id: string, fields: Partial<Omit<ArtifactRow, "id" | "created_at">>): void;
  remove(id: string): void;
  delete(id: string): void;
}

// ── SQLite implementation ──

export class SqliteArtifactStore implements ArtifactStore {
  private stmts: {
    getAll: Database.Statement;
    getById: Database.Statement;
    getBySpaceId: Database.Statement;
    getByPath: Database.Statement;
    getDistinctSpaces: Database.Statement;
    insert: Database.Statement;
    delete: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      getAll: db.prepare("SELECT * FROM artifacts WHERE removed_at IS NULL ORDER BY space_id, created_at"),
      getById: db.prepare("SELECT * FROM artifacts WHERE id = ?"),
      getBySpaceId: db.prepare("SELECT * FROM artifacts WHERE space_id = ? AND removed_at IS NULL ORDER BY created_at"),
      getByPath: db.prepare("SELECT * FROM artifacts WHERE json_extract(storage_config, '$.path') = ? AND removed_at IS NULL"),
      getDistinctSpaces: db.prepare("SELECT space_id, COUNT(*) as count FROM artifacts WHERE removed_at IS NULL GROUP BY space_id ORDER BY space_id"),
      insert: db.prepare(`
        INSERT INTO artifacts (id, owner_id, space_id, label, artifact_kind, storage_kind, storage_config, runtime_kind, runtime_config, group_name)
        VALUES (@id, @owner_id, @space_id, @label, @artifact_kind, @storage_kind, @storage_config, @runtime_kind, @runtime_config, @group_name)
      `),
      delete: db.prepare("DELETE FROM artifacts WHERE id = ?"),
    };
  }

  getAll(): ArtifactRow[] {
    return this.stmts.getAll.all() as ArtifactRow[];
  }

  getById(id: string): ArtifactRow | undefined {
    return this.stmts.getById.get(id) as ArtifactRow | undefined;
  }

  getBySpaceId(spaceId: string): ArtifactRow[] {
    return this.stmts.getBySpaceId.all(spaceId) as ArtifactRow[];
  }

  getByPath(absPath: string): ArtifactRow | undefined {
    return this.stmts.getByPath.get(absPath) as ArtifactRow | undefined;
  }

  getDistinctSpaces(): { space_id: string; count: number }[] {
    return this.stmts.getDistinctSpaces.all() as { space_id: string; count: number }[];
  }

  insert(row: InsertRow): void {
    this.stmts.insert.run(row);
  }

  private static readonly UPDATABLE_COLUMNS = new Set([
    "owner_id", "space_id", "label", "artifact_kind",
    "storage_kind", "storage_config", "runtime_kind", "runtime_config", "group_name",
  ]);

  update(id: string, fields: Partial<Omit<ArtifactRow, "id" | "created_at">>): void {
    const sets: string[] = [];
    const values: Record<string, unknown> = { id };

    for (const [key, value] of Object.entries(fields)) {
      if (!SqliteArtifactStore.UPDATABLE_COLUMNS.has(key)) continue;
      sets.push(`${key} = @${key}`);
      values[key] = value;
    }

    if (sets.length === 0) return;

    sets.push("updated_at = datetime('now')");
    this.db.prepare(`UPDATE artifacts SET ${sets.join(", ")} WHERE id = @id`).run(values);
  }

  remove(id: string): void {
    this.db.prepare("UPDATE artifacts SET removed_at = datetime('now') WHERE id = ?").run(id);
  }

  delete(id: string): void {
    this.stmts.delete.run(id);
  }
}
