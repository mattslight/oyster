// Resolve a folder to its project + space by reading `.oyster/id` and
// joining against the `projects` table. Called by the watcher at session
// ingest time so new sessions tag with `project_id` directly, without
// any path-prefix scan against `sources`.
//
// Resolution order for a given cwd:
//   1. Walk up parent directories looking for `<dir>/.oyster/id`. The
//      first valid marker whose UUID resolves to a live project wins.
//      This preserves the old "descendant of an attached source" binding
//      — sessions started in `<project>/web/src` tag to `<project>`.
//   2. If no marker is found, fall back to the `project_paths` cache:
//      when exactly one live project has previously been seen at this
//      exact cwd, adopt it and self-heal the marker. Ambiguous matches
//      and soft-deleted-only matches return NONE.

import type Database from "better-sqlite3";
import { dirname } from "node:path";
import { readOysterId, writeOysterId } from "./oyster-id.js";

export interface ProjectLookup {
  projectId: string | null;
  spaceId: string | null;
}

const NONE: ProjectLookup = { projectId: null, spaceId: null };

// Bound the walk so a session at `/` (or a path that loops forever
// because we mis-handle some filesystem quirk) doesn't spin. 32 is
// generous — real project layouts rarely exceed 8 levels.
const MAX_WALK_DEPTH = 32;

export function lookupProject(db: Database.Database, cwd: string | null): ProjectLookup {
  if (!cwd) return NONE;

  // 1. Walk up looking for a valid marker that resolves to a live project.
  let dir = cwd;
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    const result = readOysterId(dir);
    if (result.status === "valid") {
      const row = db
        .prepare("SELECT id, space_id FROM projects WHERE id = ? AND removed_at IS NULL")
        .get(result.id) as { id: string; space_id: string } | undefined;
      if (row) {
        cachePath(db, row.id, cwd);
        return { projectId: row.id, spaceId: row.space_id };
      }
      // Marker present but project unknown or soft-deleted — stop walking.
      // We trust the deepest marker; ascending past it would pick up an
      // ancestor's project even though the user explicitly placed this
      // marker as a sub-project boundary.
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // hit fs root
    dir = parent;
  }

  // 2. Cache fallback — walk parent dirs looking for ANY ancestor whose
  // path is in project_paths. A session at `<root>/web/src` with no
  // marker anywhere should still resolve to the project attached at
  // `<root>`. Stops at the first ancestor with exactly one live cache
  // hit (ambiguous hits = abstain). Self-heals by writing the marker
  // at the original cwd (not the ancestor) so future ingests are
  // direct, and re-caches the exact cwd so this walk is one-shot.
  let cacheDir = cwd;
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    const cached = db
      .prepare(
        `SELECT p.id, p.space_id
           FROM project_paths pp
           JOIN projects p ON p.id = pp.project_id
          WHERE pp.path = ? AND p.removed_at IS NULL
          LIMIT 2`,
      )
      .all(cacheDir) as Array<{ id: string; space_id: string }>;
    if (cached.length === 1) {
      const row = cached[0];
      try { writeOysterId(cwd, row.id); } catch { /* permissions / read-only fs — fallback still resolves */ }
      cachePath(db, row.id, cwd);
      return { projectId: row.id, spaceId: row.space_id };
    }
    if (cached.length > 1) break; // ambiguous at this level — abstain
    const parent = dirname(cacheDir);
    if (parent === cacheDir) break;
    cacheDir = parent;
  }
  return NONE;
}

function cachePath(db: Database.Database, projectId: string, path: string): void {
  db.prepare(
    `INSERT INTO project_paths (project_id, path) VALUES (?, ?)
     ON CONFLICT(project_id, path) DO UPDATE SET last_seen_at = datetime('now')`,
  ).run(projectId, path);
}
