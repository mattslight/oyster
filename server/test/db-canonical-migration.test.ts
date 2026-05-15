// Smoke test for the one-time canonical-form migration that runs on
// every initDb call. Pre-PR-490 installs (especially Windows) may have
// `sources.path` and `sessions.cwd` rows with backslash separators or
// trailing slashes; the new substr-based prefix SQL requires both sides
// to be canonical. The migration rewrites them in place. Idempotent.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initDb } from "../src/db.js";

function seedRawRows(dbPath: string) {
  // Pre-canonical fixture: write rows with separators/forms the new
  // SQL wouldn't match, then close so initDb opens fresh.
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  // Minimal schema for the columns under test — initDb does the rest
  // when it re-opens.
  db.exec(`
    CREATE TABLE IF NOT EXISTS spaces (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, color TEXT,
      scan_status TEXT NOT NULL DEFAULT 'none' CHECK (scan_status IN ('none','scanning','complete','error')),
      scan_error TEXT, last_scanned_at TEXT, last_scan_summary TEXT,
      ai_job_status TEXT CHECK (ai_job_status IS NULL OR ai_job_status IN ('pending','running','complete','error')),
      ai_job_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'local_folder',
      path TEXT NOT NULL,
      label TEXT,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      removed_at TEXT
    );
  `);
  db.prepare("INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('sp', 'sp', '#000', 'none')").run();
  // Backslash path (simulates a Windows install pre-canonicalisation).
  db.prepare(`INSERT INTO sources (id, space_id, type, path) VALUES ('win', 'sp', 'local_folder', 'C:\\Users\\matt\\repo')`).run();
  // Trailing-slash path (simulates an old macOS row).
  db.prepare("INSERT INTO sources (id, space_id, type, path) VALUES ('trail', 'sp', 'local_folder', '/Users/me/proj/')").run();
  // Already-canonical row — must be left untouched (idempotent).
  db.prepare("INSERT INTO sources (id, space_id, type, path) VALUES ('clean', 'sp', 'local_folder', '/Users/me/clean')").run();
  // Windows drive root — must not be stripped to `C:` (invalid path).
  db.prepare(`INSERT INTO sources (id, space_id, type, path) VALUES ('drive', 'sp', 'local_folder', 'C:\\')`).run();
  // POSIX root — must stay `/`, not be flattened to '' by the trim.
  db.prepare("INSERT INTO sources (id, space_id, type, path) VALUES ('root', 'sp', 'local_folder', '/')").run();
  db.close();
}

describe("initDb canonical-form migration", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "oyster-mig-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("rewrites backslash separators and trims trailing slashes; leaves canonical rows alone", () => {
    const dbPath = join(dir, "oyster.db");
    seedRawRows(dbPath);

    // initDb runs the migration as part of its boot routine.
    const db = initDb(dir);
    const rows = db.prepare("SELECT id, path FROM sources ORDER BY id").all() as Array<{ id: string; path: string }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.path]));

    expect(byId.win).toBe("C:/Users/matt/repo");
    expect(byId.trail).toBe("/Users/me/proj");
    expect(byId.clean).toBe("/Users/me/clean");
    // Drive root preserved (Copilot review).
    expect(byId.drive).toBe("C:/");
    // POSIX root preserved.
    expect(byId.root).toBe("/");

    // Idempotent: a second initDb on the same file must not change rows.
    db.close();
    const db2 = initDb(dir);
    const rows2 = db2.prepare("SELECT id, path FROM sources ORDER BY id").all() as Array<{ id: string; path: string }>;
    expect(rows2.map((r) => r.path)).toEqual(rows.map((r) => r.path));
    db2.close();
  });

  it("normalises sessions.cwd alongside sources.path", () => {
    const dbPath = join(dir, "oyster.db");
    seedRawRows(dbPath);
    // Add a sessions row with a backslash cwd — the test fixture's
    // minimal schema doesn't include the sessions table yet, but initDb
    // creates it on first open, so re-open to add the row, then close
    // and re-open to fire the migration.
    {
      const db = initDb(dir);
      db.prepare(`INSERT INTO sessions (id, space_id, source_id, cwd, agent, title, state, started_at, last_event_at)
                  VALUES ('s', 'sp', NULL, ?, 'claude-code', 't', 'done',
                          '2026-05-15T10:00:00Z', '2026-05-15T10:30:00Z')`)
        .run("C:\\Users\\matt\\repo\\web\\");
      // Knock it back to the raw form (the insert went through after the
      // migration already ran, so we have to corrupt it on purpose to
      // test the migration loop on the next open).
      db.prepare("UPDATE sessions SET cwd = ? WHERE id = 's'").run("C:\\Users\\matt\\repo\\web\\");
      db.close();
    }
    const db2 = initDb(dir);
    const cwd = (db2.prepare("SELECT cwd FROM sessions WHERE id = 's'").get() as { cwd: string }).cwd;
    expect(cwd).toBe("C:/Users/matt/repo/web");
    db2.close();
  });
});
