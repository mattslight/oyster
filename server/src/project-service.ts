// Business logic for projects — the simplified identity surface that
// replaces the source-shaped halves of SpaceService. A project owns its id
// (== .oyster/id when written to disk, fresh UUID otherwise), a parent
// space, and a name. Paths are advisory cache in `project_paths`, never
// authoritative — folder renames are filesystem ops that don't touch
// identity.

import type Database from "better-sqlite3";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { readOysterId, writeOysterId } from "./oyster-id.js";

// `~/foo` and `~` → `<home>/foo` / `<home>`. The UI accepts tilde paths
// in the "Add project" form; without this expansion the marker, the
// project_paths cache, and claimOrphan would all operate on the literal
// `~` string. Only leading `~` is expanded — no `~user` lookup, which is
// POSIX-only and a CVE-shape we don't need.
function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return homedir() + path.slice(1);
  return path;
}

export interface Project {
  id: string;
  spaceId: string;
  name: string;
  createdAt: string;
  /** Most-recent cached path on this machine — used for tile labels +
   *  tooltips. Null when no path has ever been cached for this project. */
  recentPath?: string | null;
  /** True when at least one of this project's cached paths exists on
   *  disk. False = "homeless": the project only lives as a DB row, the
   *  folder it came from has been renamed/moved/unmounted. Homeless
   *  projects are the candidates for merging into a live project — no
   *  marker rewrite needed, just a DB-side absorb. */
  hasLivePath?: boolean;
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
    return rows.map((row) => ({ ...rowToProject(row), ...this.detectPathState(row.id) }));
  }

  /** Lookup a single non-removed project by id, with path state attached.
   *  Used by terminal-launch to resolve a cwd from a project reference. */
  getById(id: string): Project | null {
    const row = this.db
      .prepare("SELECT id, space_id, name, created_at FROM projects WHERE id = ? AND removed_at IS NULL")
      .get(id) as ProjectRow | undefined;
    if (!row) return null;
    return { ...rowToProject(row), ...this.detectPathState(row.id) };
  }

  // Walk this project's cached paths once and derive:
  //   - recentPath  (most-recent, for display)
  //   - hasLivePath (ANY path exists on disk → not homeless)
  //   - isGitRepo   (the most-recent path contains a .git entry)
  // Three checks → one pass over `project_paths`. Stat is cheap; even a
  // few thousand projects stay sub-millisecond.
  private detectPathState(projectId: string): { recentPath: string | null; hasLivePath: boolean; isGitRepo: boolean } {
    const paths = this.db
      .prepare("SELECT path FROM project_paths WHERE project_id = ? ORDER BY last_seen_at DESC")
      .all(projectId) as Array<{ path: string }>;
    if (paths.length === 0) return { recentPath: null, hasLivePath: false, isGitRepo: false };
    const recent = paths[0].path;
    let hasLivePath = false;
    for (const { path } of paths) {
      if (existsSync(path)) { hasLivePath = true; break; }
    }
    // `.git` is a folder for normal repos and a file for worktrees /
    // submodules. existsSync handles both. Path-missing returns false —
    // fine, the badge just doesn't show.
    const isGitRepo = existsSync(join(recent, ".git"));
    return { recentPath: recent, hasLivePath, isGitRepo };
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
    // Strip trailing path separators. If the cwd is just separators
    // ("/" / "\\" / "//"), root becomes empty — fall back to exact-match
    // only to avoid claiming every session.
    const root = args.cwd.replace(/[\\/]+$/, "");
    if (!root) {
      const info = this.db
        .prepare(
          `UPDATE sessions
              SET project_id = @projectId, space_id = @spaceId
            WHERE cwd = @cwd AND project_id IS NULL`,
        )
        .run({ projectId: args.projectId, spaceId: project.space_id, cwd: args.cwd });
      return { claimed: Number(info.changes) };
    }
    // Descendant match via substr instead of LIKE so we sidestep
    // wildcard injection (`_`/`%` in folder names) AND handle both
    // separators (`/` on POSIX, `\` on Windows) without escape gymnastics.
    // The `+ 1` is the boundary separator, so `<root>` does NOT swallow
    // `<root>-other` (no separator between them).
    const info = this.db
      .prepare(
        `UPDATE sessions
            SET project_id = @projectId, space_id = @spaceId
          WHERE (
            cwd = @root
            OR substr(cwd, 1, @bound) = @root || '/'
            OR substr(cwd, 1, @bound) = @root || '\\'
          )
            AND project_id IS NULL`,
      )
      .run({
        projectId: args.projectId,
        spaceId: project.space_id,
        root,
        bound: root.length + 1,
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
    const path = expandTilde(args.path);
    const fallbackName = args.name ?? basename(path);
    const existing = readOysterId(path);
    let project: Project;

    if (existing.status === "valid") {
      const row = this.db
        .prepare("SELECT id, space_id, name, created_at, removed_at FROM projects WHERE id = ?")
        .get(existing.id) as (ProjectRow & { removed_at: string | null }) | undefined;
      if (row) {
        // Local row exists: adopt; undelete + move space if the caller
        // wants a different home. The space migration must ALSO sweep
        // sessions/artefacts bound to this project at OTHER cached
        // paths, otherwise they stay stranded in the old space's tile
        // (which no longer owns this project).
        if (row.removed_at || row.space_id !== args.spaceId) {
          this.relocateProjectToSpace(row.id, args.spaceId);
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
        .all(path) as Array<ProjectRow & { removed_at: string | null }>;
      if (cached.length === 1) {
        const row = cached[0];
        if (row.removed_at || row.space_id !== args.spaceId) {
          this.relocateProjectToSpace(row.id, args.spaceId);
          row.space_id = args.spaceId;
        }
        tryWriteOysterId(path, row.id);
        project = rowToProject(row);
      } else {
        // Either nothing cached, or ambiguous (2+ projects claim this path).
        // Mint fresh in both cases — ambiguity is the user's signal to pick
        // a different attach name.
        project = this.createProject({ spaceId: args.spaceId, name: fallbackName });
        tryWriteOysterId(path, project.id);
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
      .run(project.id, path);
    const { claimed } = this.claimOrphan({ cwd: path, projectId: project.id });
    return { project, claimed };
  }

  // Move a project + its bound sessions/artefacts into a new space, in
  // one transaction. Used by attachFolder's undelete-or-rebase branch
  // when the caller's spaceId differs from the row's stored space_id.
  // Without the cascade, sessions at cached paths other than the
  // attach cwd would stay in the old space and render in the wrong
  // tile.
  private relocateProjectToSpace(projectId: string, spaceId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE projects SET removed_at = NULL, space_id = ? WHERE id = ?")
        .run(spaceId, projectId);
      this.db.prepare("UPDATE sessions SET space_id = ? WHERE project_id = ?").run(spaceId, projectId);
      this.db.prepare("UPDATE artifacts SET space_id = ? WHERE project_id = ?").run(spaceId, projectId);
    })();
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

  // Merge `from` into `into`: migrate sessions/artefacts/project_paths,
  // rewrite `.oyster/id` on each of from's live folders so future sessions
  // there bind to `into`, then soft-delete `from`. Cross-space is allowed
  // — the result lives in `into`'s space.
  //
  // DB updates run in a transaction. The marker rewrites happen after
  // commit because they're filesystem side-effects that can fail (missing
  // folder / read-only fs) without corrupting the DB; `writeOysterId`
  // refuses to materialise non-existent folders so this is safe.
  mergeProjects(args: { intoId: string; fromId: string }): { sessionsMoved: number; artefactsMoved: number; pathsMoved: number } {
    if (args.intoId === args.fromId) throw new Error("Cannot merge a project into itself");
    const into = this.db
      .prepare("SELECT id, space_id FROM projects WHERE id = ? AND removed_at IS NULL")
      .get(args.intoId) as { id: string; space_id: string } | undefined;
    if (!into) throw new Error(`Project "${args.intoId}" not found`);
    const from = this.db
      .prepare("SELECT id FROM projects WHERE id = ? AND removed_at IS NULL")
      .get(args.fromId) as { id: string } | undefined;
    if (!from) throw new Error(`Project "${args.fromId}" not found`);

    // Snapshot from's paths before the move so we can rewrite their markers.
    const fromPaths = this.db
      .prepare("SELECT path FROM project_paths WHERE project_id = ?")
      .all(args.fromId) as Array<{ path: string }>;

    const counts = this.db.transaction(() => {
      const sessions = this.db
        .prepare("UPDATE sessions SET project_id = ?, space_id = ? WHERE project_id = ?")
        .run(into.id, into.space_id, args.fromId);
      const artefacts = this.db
        .prepare("UPDATE artifacts SET project_id = ?, space_id = ? WHERE project_id = ?")
        .run(into.id, into.space_id, args.fromId);
      // De-dup PK conflicts (same path cached against both projects) by
      // dropping the loser's row before the bulk update.
      this.db
        .prepare(
          `DELETE FROM project_paths
            WHERE project_id = ?
              AND path IN (SELECT path FROM project_paths WHERE project_id = ?)`,
        )
        .run(args.fromId, into.id);
      const paths = this.db
        .prepare("UPDATE project_paths SET project_id = ? WHERE project_id = ?")
        .run(into.id, args.fromId);
      this.db
        .prepare("UPDATE projects SET removed_at = datetime('now') WHERE id = ?")
        .run(args.fromId);
      return {
        sessionsMoved: Number(sessions.changes),
        artefactsMoved: Number(artefacts.changes),
        pathsMoved: Number(paths.changes),
      };
    })();

    // Rewrite the marker on each formerly-`from` folder that exists on
    // disk. `writeOysterId` throws on missing folders (won't resurrect
    // ghosts), `tryWriteOysterId` swallows that gracefully.
    for (const { path } of fromPaths) {
      tryWriteOysterId(path, into.id);
    }

    return counts;
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
