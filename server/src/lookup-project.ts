// Resolve a folder to its project + space by reading `<cwd>/.oyster/id`
// and joining against the `projects` table. Called by the watcher at
// session-ingest time so new sessions tag with `project_id` directly,
// without any path-prefix scan against `sources`.

import type Database from "better-sqlite3";
import { readOysterId, writeOysterId } from "./oyster-id.js";

export interface ProjectLookup {
  projectId: string | null;
  spaceId: string | null;
}

const NONE: ProjectLookup = { projectId: null, spaceId: null };

export function lookupProject(db: Database.Database, cwd: string | null): ProjectLookup {
  if (!cwd) return NONE;
  const result = readOysterId(cwd);

  if (result.status === "valid") {
    const row = db
      .prepare("SELECT id, space_id FROM projects WHERE id = ? AND removed_at IS NULL")
      .get(result.id) as { id: string; space_id: string } | undefined;
    if (row) {
      cachePath(db, row.id, cwd);
      return { projectId: row.id, spaceId: row.space_id };
    }
    return NONE;
  }

  // Fallback: .oyster/id missing or malformed but we've seen this folder
  // before (project_paths cache). When exactly one live project claims
  // this path, adopt it and rewrite the marker so subsequent reads go
  // through the happy path. Ambiguous (2+ matches) or soft-deleted-only
  // matches return NONE — the user must re-attach explicitly.
  const cached = db
    .prepare(
      `SELECT p.id, p.space_id
         FROM project_paths pp
         JOIN projects p ON p.id = pp.project_id
        WHERE pp.path = ? AND p.removed_at IS NULL
        LIMIT 2`,
    )
    .all(cwd) as Array<{ id: string; space_id: string }>;
  if (cached.length === 1) {
    const row = cached[0];
    try {
      writeOysterId(cwd, row.id);
    } catch {
      // Write failure (permissions, read-only fs) is non-fatal — the
      // binding still resolves for this session; next time we'll try the
      // cache again.
    }
    cachePath(db, row.id, cwd);
    return { projectId: row.id, spaceId: row.space_id };
  }
  return NONE;
}

function cachePath(db: Database.Database, projectId: string, path: string): void {
  db.prepare(
    `INSERT INTO project_paths (project_id, path) VALUES (?, ?)
     ON CONFLICT(project_id, path) DO UPDATE SET last_seen_at = datetime('now')`,
  ).run(projectId, path);
}
