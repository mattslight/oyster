// Business logic for projects — the simplified identity surface that
// replaces the source-shaped halves of SpaceService. A project owns its id
// (== .oyster/id when written to disk, fresh UUID otherwise), a parent
// space, and a name. Paths are advisory cache in `project_paths`, never
// authoritative — folder renames are filesystem ops that don't touch
// identity.

import type Database from "better-sqlite3";
import { basename } from "node:path";
import { readOysterId, writeOysterId } from "./oyster-id.js";

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

function tryWriteOysterId(path: string, id: string): void {
  // writeOysterId can fail when the folder doesn't exist on disk (orphan-
  // attach for a renamed/missing folder) or the fs is read-only. The
  // binding still works locally via project_paths cache + claimOrphan, so
  // we swallow the error rather than aborting the whole attach.
  try { writeOysterId(path, id); } catch { /* non-fatal */ }
}

export class ProjectService {
  constructor(private db: Database.Database) {}

  listForSpace(spaceId: string): Project[] {
    const rows = this.db
      .prepare("SELECT id, space_id, name, created_at FROM projects WHERE space_id = ? AND removed_at IS NULL ORDER BY name COLLATE NOCASE")
      .all(spaceId) as ProjectRow[];
    return rows.map(rowToProject);
  }

  // Bulk-tag orphan sessions whose `cwd` matches the project's path —
  // exactly OR as a descendant. Sessions in `<project>/web/src` bind to
  // the project attached at `<project>`. Sibling paths (`<project>-other`)
  // do NOT match because of the `/` boundary. Skips rows already bound to
  // any project (those need an explicit move, not a claim).
  claimOrphan(args: { cwd: string; projectId: string }): { claimed: number } {
    const project = this.db
      .prepare("SELECT space_id FROM projects WHERE id = ? AND removed_at IS NULL")
      .get(args.projectId) as { space_id: string } | undefined;
    if (!project) throw new Error(`Project "${args.projectId}" not found`);
    // Strip a trailing slash so the boundary pattern below doesn't double up.
    const root = args.cwd.replace(/\/+$/, "");
    const info = this.db
      .prepare(
        `UPDATE sessions
            SET project_id = @projectId, space_id = @spaceId
          WHERE (cwd = @root OR cwd LIKE @prefix)
            AND project_id IS NULL`,
      )
      .run({
        projectId: args.projectId,
        spaceId: project.space_id,
        root,
        prefix: root + "/%",
      });
    return { claimed: Number(info.changes) };
  }

  // Idempotent attach. Resolution order:
  //   1. `.oyster/id` valid → adopt that project (undelete + cross-space
  //      move if needed). If the marker names a UUID that has no local row
  //      yet (the cross-device clone case) we create a project WITH THAT
  //      UUID — never mint a fresh one or overwrite the marker.
  //   2. No marker but `project_paths` cache claims this path → adopt that
  //      project + self-heal the marker.
  //   3. Else → create a fresh project + write the marker.
  // Finishes by claiming orphan sessions (exact + descendant cwds).
  attachFolder(args: { spaceId: string; path: string; name?: string }): { project: Project; claimed: number } {
    const fallbackName = args.name ?? basename(args.path);
    const existing = readOysterId(args.path);
    let project: Project;

    if (existing.status === "valid") {
      const row = this.db
        .prepare("SELECT id, space_id, name, created_at, removed_at FROM projects WHERE id = ?")
        .get(existing.id) as (ProjectRow & { removed_at: string | null }) | undefined;
      if (row) {
        // Local row exists: adopt; undelete + move space if the caller
        // wants a different home.
        if (row.removed_at || row.space_id !== args.spaceId) {
          this.db
            .prepare("UPDATE projects SET removed_at = NULL, space_id = ? WHERE id = ?")
            .run(args.spaceId, row.id);
          row.space_id = args.spaceId;
        }
        project = rowToProject(row);
      } else {
        // Marker names a UUID we've never seen locally — cross-device case.
        // Adopt the foreign UUID so cross-machine identity survives.
        project = this.createProject({ spaceId: args.spaceId, name: fallbackName, id: existing.id });
      }
    } else {
      // No marker. Try the project_paths cache before minting a new UUID
      // — this is what prevents the "+ Add project" / orphan-attach
      // duplicate-creation footgun.
      const cached = this.db
        .prepare(`
          SELECT p.id, p.space_id, p.name, p.created_at, p.removed_at
            FROM project_paths pp
            JOIN projects p ON p.id = pp.project_id
           WHERE pp.path = ?
           LIMIT 2
        `)
        .all(args.path) as Array<ProjectRow & { removed_at: string | null }>;
      if (cached.length === 1) {
        const row = cached[0];
        if (row.removed_at || row.space_id !== args.spaceId) {
          this.db
            .prepare("UPDATE projects SET removed_at = NULL, space_id = ? WHERE id = ?")
            .run(args.spaceId, row.id);
          row.space_id = args.spaceId;
        }
        tryWriteOysterId(args.path, row.id);
        project = rowToProject(row);
      } else {
        // Either nothing cached, or ambiguous (2+ projects claim this path).
        // Mint fresh in both cases — ambiguity is the user's signal to pick
        // a different attach name.
        project = this.createProject({ spaceId: args.spaceId, name: fallbackName });
        tryWriteOysterId(args.path, project.id);
      }
    }

    const { claimed } = this.claimOrphan({ cwd: args.path, projectId: project.id });
    return { project, claimed };
  }

  createProject(args: { spaceId: string; name: string; id?: string }): Project {
    const id = args.id ?? crypto.randomUUID();
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
  // Soft-deleted projects are not editable; renames must surface an error
  // rather than silently land on a tombstone.
  updateProject(projectId: string, fields: { name?: string }): Project {
    if (typeof fields.name === "string") {
      const name = fields.name.trim();
      if (!name) throw new Error("name must not be empty");
      this.db.prepare("UPDATE projects SET name = ? WHERE id = ? AND removed_at IS NULL").run(name, projectId);
    }
    const row = this.db
      .prepare("SELECT id, space_id, name, created_at FROM projects WHERE id = ? AND removed_at IS NULL")
      .get(projectId) as ProjectRow | undefined;
    if (!row) throw new Error(`Project "${projectId}" not found`);
    return rowToProject(row);
  }
}
