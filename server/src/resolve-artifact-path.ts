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

import { statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type Database from "better-sqlite3";

const MAX_WALK_DEPTH = 32;

// True iff the path definitely doesn't exist (ENOENT / ENOTDIR). Any
// other stat error — permissions, slow drive timeout — re-throws or
// returns true (we treat transient IO failures as "still here" so we
// don't tombstone artefacts whose backing drives are temporarily slow).
function pathExistsOrThrow(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    // Anything else (EACCES, EIO, EBUSY, etc.) is a transient or
    // permission issue. Treat as "exists, can't tell" so we don't
    // false-tombstone or false-recover.
    return true;
  }
}

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
    // LIMIT 2 + abstain on multi-match — if two live projects share a
    // cached path (rare but possible from a buggy attach), picking
    // arbitrarily would silently route the artefact to the wrong one.
    const rows = db
      .prepare(
        `SELECT DISTINCT pp.project_id
           FROM project_paths pp
           JOIN projects p ON p.id = pp.project_id
          WHERE pp.path = ? AND p.removed_at IS NULL
          LIMIT 2`,
      )
      .all(dir) as Array<{ project_id: string }>;
    if (rows.length === 1) return rows[0].project_id;
    if (rows.length > 1) return null; // ambiguous — abstain
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
    const rows = db
      .prepare(
        `SELECT DISTINCT pp.project_id
           FROM project_paths pp
           JOIN projects p ON p.id = pp.project_id
          WHERE pp.path = ? AND p.removed_at IS NULL
          LIMIT 2`,
      )
      .all(dir) as Array<{ project_id: string }>;
    if (rows.length === 1) {
      owningProjectId = rows[0].project_id;
      owningAncestor = dir;
      break;
    }
    if (rows.length > 1) return null; // ambiguous owner — abstain
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
    // Stat-based check: only ENOENT/ENOTDIR counts as missing. A
    // permission glitch or busy drive returns "exists, can't tell" so
    // we don't silently miss a real candidate.
    if (pathExistsOrThrow(candidatePath)) matches.push(candidatePath);
  }
  if (matches.length !== 1) return null;
  return { newPath: matches[0], projectId: owningProjectId };
}
