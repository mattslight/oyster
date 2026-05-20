// Stub session rows are inserted at PTY spawn time so the running pill
// can pick them up immediately (see routes/terminals.ts). If a spawn
// ends without claude ever writing a JSONL (user closed the terminal
// before sending a prompt, claude crashed early, etc.), the row remains
// as a ghost: visible in the Sessions list, but `claude --resume <id>`
// fails because there is no conversation file.
//
// Predicate is stricter than "no events" alone: the watcher can lag
// behind file writes, so we only treat a row as a ghost when BOTH the
// events table is empty AND no JSONL file exists on disk. Otherwise we
// might delete a session whose events are still being ingested.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { SessionStore } from "./session-store.js";
import { encodeCwd, projectsRoot } from "./session-sync-service.js";

/** Internal check: does this session have any real conversation backing
 *  it? Returns true when at least one event row OR a JSONL file exists. */
function sessionHasContent(
  db: Database.Database,
  sessionId: string,
  cwd: string | null,
): boolean {
  const row = db
    .prepare("SELECT 1 FROM session_events WHERE session_id = ? LIMIT 1")
    .get(sessionId);
  if (row) return true;
  if (!cwd) return false;
  const path = join(projectsRoot(), encodeCwd(cwd), `${sessionId}.jsonl`);
  return existsSync(path);
}

/** Delete the row if this session never produced content. Called from
 *  ClaudePtyManager._handleExit. Returns true when a delete happened. */
export function deleteIfGhostOnExit(
  store: SessionStore,
  db: Database.Database,
  sessionId: string,
  cwd: string | null,
): boolean {
  if (sessionHasContent(db, sessionId, cwd)) return false;
  store.deleteSession(sessionId);
  return true;
}

/** Boot-time scan: find rows that are ghosts and drop them. Idempotent —
 *  a clean DB produces zero deletes and zero work. */
export function cleanupGhostSessionsAtBoot(
  store: SessionStore,
  db: Database.Database,
): { deleted: number } {
  // Sessions without an in-memory terminal can be candidates. At boot
  // every terminal_id has already been NULLed by the existing reset in
  // db.ts, so this read is safe — no PTY is alive yet.
  const candidates = db
    .prepare("SELECT id, cwd FROM sessions WHERE terminal_id IS NULL")
    .all() as Array<{ id: string; cwd: string | null }>;

  let deleted = 0;
  for (const row of candidates) {
    if (!sessionHasContent(db, row.id, row.cwd)) {
      store.deleteSession(row.id);
      deleted++;
    }
  }
  return { deleted };
}
