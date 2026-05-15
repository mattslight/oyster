// Business logic for projects — the simplified identity surface that
// replaces the source-shaped halves of SpaceService. A project owns its id
// (== .oyster/id when written to disk, fresh UUID otherwise), a parent
// space, and a name. Paths are advisory cache in `project_paths`, never
// authoritative — folder renames are filesystem ops that don't touch
// identity.

import type Database from "better-sqlite3";

export interface Project {
  id: string;
  spaceId: string;
  name: string;
  createdAt: string;
}

interface ProjectRow {
  id: string;
  space_id: string;
  name: string;
  created_at: string;
}

function rowToProject(row: ProjectRow): Project {
  return { id: row.id, spaceId: row.space_id, name: row.name, createdAt: row.created_at };
}

export class ProjectService {
  constructor(private db: Database.Database) {}

  listForSpace(spaceId: string): Project[] {
    const rows = this.db
      .prepare("SELECT id, space_id, name, created_at FROM projects WHERE space_id = ? AND removed_at IS NULL ORDER BY name COLLATE NOCASE")
      .all(spaceId) as ProjectRow[];
    return rows.map(rowToProject);
  }

  // Bulk-tag orphan sessions whose `cwd` exactly matches with the given
  // project. Skips rows already bound to any project (including a different
  // one — those need an explicit move, not a claim). `space_id` follows the
  // project so the surface shows the sessions under the right tile.
  claimOrphan(args: { cwd: string; projectId: string }): { claimed: number } {
    const project = this.db
      .prepare("SELECT space_id FROM projects WHERE id = ? AND removed_at IS NULL")
      .get(args.projectId) as { space_id: string } | undefined;
    if (!project) throw new Error(`Project "${args.projectId}" not found`);
    const info = this.db
      .prepare(
        `UPDATE sessions
            SET project_id = @projectId, space_id = @spaceId
          WHERE cwd = @cwd AND project_id IS NULL`,
      )
      .run({ projectId: args.projectId, spaceId: project.space_id, cwd: args.cwd });
    return { claimed: Number(info.changes) };
  }

  createProject(args: { spaceId: string; name: string }): Project {
    const id = crypto.randomUUID();
    const name = args.name.trim();
    if (!name) throw new Error("name must not be empty");
    this.db
      .prepare("INSERT INTO projects (id, space_id, name) VALUES (?, ?, ?)")
      .run(id, args.spaceId, name);
    const row = this.db
      .prepare("SELECT id, space_id, name, created_at FROM projects WHERE id = ?")
      .get(id) as ProjectRow;
    return rowToProject(row);
  }

  // Soft-delete. The row stays so sessions.project_id FKs keep resolving
  // (UI just stops surfacing the tile via listForSpace). Reattach later
  // by creating a new project and claiming orphans into it.
  deleteProject(projectId: string): void {
    const info = this.db
      .prepare("UPDATE projects SET removed_at = datetime('now') WHERE id = ? AND removed_at IS NULL")
      .run(projectId);
    if (info.changes === 0) throw new Error(`Project "${projectId}" not found`);
  }

  // Currently only `name` is updatable. `spaceId` is intentionally
  // immutable — a project moves spaces by being recreated, not edited.
  updateProject(projectId: string, fields: { name?: string }): Project {
    if (typeof fields.name === "string") {
      const name = fields.name.trim();
      if (!name) throw new Error("name must not be empty");
      this.db.prepare("UPDATE projects SET name = ? WHERE id = ? AND removed_at IS NULL").run(name, projectId);
    }
    const row = this.db
      .prepare("SELECT id, space_id, name, created_at FROM projects WHERE id = ?")
      .get(projectId) as ProjectRow | undefined;
    if (!row) throw new Error(`Project "${projectId}" not found`);
    return rowToProject(row);
  }
}
