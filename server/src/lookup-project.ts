// Resolve a folder to its project + space by reading `<cwd>/.oyster/id`
// and joining against the `projects` table. Called by the watcher at
// session-ingest time so new sessions tag with `project_id` directly,
// without any path-prefix scan against `sources`.

import type Database from "better-sqlite3";
import { readOysterId } from "./oyster-id.js";

export interface ProjectLookup {
  projectId: string | null;
  spaceId: string | null;
}

const NONE: ProjectLookup = { projectId: null, spaceId: null };

export function lookupProject(db: Database.Database, cwd: string | null): ProjectLookup {
  if (!cwd) return NONE;
  const result = readOysterId(cwd);
  if (result.status !== "valid") return NONE;
  const row = db
    .prepare("SELECT id, space_id FROM projects WHERE id = ? AND removed_at IS NULL")
    .get(result.id) as { id: string; space_id: string } | undefined;
  if (!row) return NONE;
  // Cache this device's view of where the project lives. ON CONFLICT keeps
  // the original row's created-at semantics but bumps last_seen_at so stale
  // paths surface in the UI.
  db.prepare(
    `INSERT INTO project_paths (project_id, path) VALUES (?, ?)
     ON CONFLICT(project_id, path) DO UPDATE SET last_seen_at = datetime('now')`,
  ).run(row.id, cwd);
  return { projectId: row.id, spaceId: row.space_id };
}
