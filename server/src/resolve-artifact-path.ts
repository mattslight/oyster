// Find an artefact's new location after a folder rename, by leveraging
// the project_paths cache. Same primitive lookupProject uses for
// sessions: walk up the stored path looking for an ancestor that's
// known as a project's cached folder; once found, try the same relative
// remainder under each of that project's OTHER cached paths and return
// the unique match. Ambiguous or no-match → null.
//
// Used by the artefact-service self-heal (replaces a blunt
// `store.remove(id)`) and by a one-shot boot migration that heals
// tombstones produced by the old self-heal.

import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type Database from "better-sqlite3";

const MAX_WALK_DEPTH = 32;

export interface ArtifactPathResolution {
  newPath: string;
  projectId: string;
}

// Walk up `path` looking for an ancestor that's cached in project_paths
// against a live project. Returns that project's id, or null when no
// ancestor matches. The deepest match wins (nested projects). Used both
// by the resolver (to know which project to search siblings under) and
// by the tombstone-recovery migration (to stamp project_id on rows
// whose original path is back).
export function findProjectAtAncestor(
  db: Database.Database,
  path: string,
): string | null {
  let dir = dirname(path);
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    const row = db
      .prepare(
        `SELECT pp.project_id
           FROM project_paths pp
           JOIN projects p ON p.id = pp.project_id
          WHERE pp.path = ? AND p.removed_at IS NULL
          LIMIT 1`,
      )
      .get(dir) as { project_id: string } | undefined;
    if (row) return row.project_id;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function resolveArtifactPathViaProjects(
  db: Database.Database,
  originalPath: string,
): ArtifactPathResolution | null {
  // 1. Walk up from the artefact's stored path; stop at the deepest
  //    ancestor that's cached in project_paths against a live project.
  //    Nested projects: the deepest ancestor wins, so a file in
  //    `<outer>/<inner>/x.md` resolves via `<inner>` not `<outer>`.
  let dir = dirname(originalPath);
  let owningProjectId: string | null = null;
  let owningAncestor: string | null = null;
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    const row = db
      .prepare(
        `SELECT pp.project_id
           FROM project_paths pp
           JOIN projects p ON p.id = pp.project_id
          WHERE pp.path = ? AND p.removed_at IS NULL
          LIMIT 1`,
      )
      .get(dir) as { project_id: string } | undefined;
    if (row) {
      owningProjectId = row.project_id;
      owningAncestor = dir;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!owningProjectId || !owningAncestor) return null;

  // 2. Compute the relative remainder + every OTHER cached path of this
  //    project. Try each candidate; collect the ones that actually exist
  //    on disk. Exactly one match → that's the new path. 0 or 2+ → bail.
  const rel = relative(owningAncestor, originalPath);
  const others = db
    .prepare("SELECT path FROM project_paths WHERE project_id = ? AND path != ?")
    .all(owningProjectId, owningAncestor) as Array<{ path: string }>;
  const matches: string[] = [];
  for (const { path: candidate } of others) {
    const candidatePath = join(candidate, rel);
    if (existsSync(candidatePath)) matches.push(candidatePath);
  }
  if (matches.length !== 1) return null;
  return { newPath: matches[0], projectId: owningProjectId };
}
