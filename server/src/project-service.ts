// Business logic for projects — the simplified identity surface that
// replaces the source-shaped halves of SpaceService. A project owns its id
// (== .oyster/id when written to disk, fresh UUID otherwise), a parent
// space, and a name. Paths are advisory cache in `project_paths`, never
// authoritative — folder renames are filesystem ops that don't touch
// identity.

import type Database from "better-sqlite3";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { readOysterId, writeOysterId } from "./oyster-id.js";

export interface Project {
  id: string;
  spaceId: string;
  name: string;
  createdAt: string;
  /** True when the project's most-recent cached path contains a `.git`
   *  entry (folder or file — git worktrees/submodules use a file).
   *  Computed at read time; never persisted, so a `git init` on disk is
   *  reflected on the next GET without any boot-scan dance. */
  isGitRepo?: boolean;
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

// SQLite LIKE treats `_` and `%` as wildcards (and `\` as literal unless
// ESCAPE is set). Folder names contain underscores all the time, so the
// raw `path||'/%'` pattern would happily eat e.g. `proj_test`'s siblings
// `projXtest`. Escape and pair with `ESCAPE '\\'` at the query site.
function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
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
    return rows.map((row) => ({ ...rowToProject(row), isGitRepo: this.detectGitRepo(row.id) }));
  }

  private detectGitRepo(projectId: string): boolean {
    const row = this.db
      .prepare("SELECT path FROM project_paths WHERE project_id = ? ORDER BY last_seen_at DESC LIMIT 1")
      .get(projectId) as { path: string } | undefined;
    if (!row) return false;
    // `.git` is a folder for normal repos and a file for worktrees /
    // submodules. existsSync handles both. Path-missing (renamed /
    // unmounted drive) returns false — fine, the badge just doesn't show.
    return existsSync(join(row.path, ".git"));
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
    // If the cwd is just slashes ("/" / "//"), root becomes empty — fall
    // back to exact-match-only to avoid a runaway `LIKE '/%'` that would
    // claim every absolute-path session.
    const root = args.cwd.replace(/\/+$/, "");
    const info = root
      ? this.db
          .prepare(
            `UPDATE sessions
                SET project_id = @projectId, space_id = @spaceId
              WHERE (cwd = @root OR cwd LIKE @prefix ESCAPE '\\')
                AND project_id IS NULL`,
          )
          .run({
            projectId: args.projectId,
            spaceId: project.space_id,
            root,
            prefix: escapeLikePattern(root) + "/%",
          })
      : this.db
          .prepare(
            `UPDATE sessions
                SET project_id = @projectId, space_id = @spaceId
              WHERE cwd = @cwd AND project_id IS NULL`,
          )
          .run({ projectId: args.projectId, spaceId: project.space_id, cwd: args.cwd });
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

    // Seed the cache for this device so a follow-up attach of the same
    // folder (or a session ingested after restart whose folder still has no
    // marker on disk) resolves via cache instead of creating a duplicate.
    this.db
      .prepare(
        `INSERT INTO project_paths (project_id, path) VALUES (?, ?)
         ON CONFLICT(project_id, path) DO UPDATE SET last_seen_at = datetime('now')`,
      )
      .run(project.id, args.path);
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

  // Soft-delete. Sessions / artefacts bound to this project are demoted
  // to true orphans (project_id → NULL) so they surface under the space
  // vault instead of getting FK-stuck to a hidden tombstone. The row
  // itself stays — re-attaching the same folder via `.oyster/id`
  // undeletes it and reclaims everything at that path.
  deleteProject(projectId: string): void {
    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare("UPDATE projects SET removed_at = datetime('now') WHERE id = ? AND removed_at IS NULL")
        .run(projectId);
      if (info.changes === 0) throw new Error(`Project "${projectId}" not found`);
      this.db.prepare("UPDATE sessions SET project_id = NULL WHERE project_id = ?").run(projectId);
      this.db.prepare("UPDATE artifacts SET project_id = NULL WHERE project_id = ?").run(projectId);
    });
    tx();
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
