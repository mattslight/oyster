import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

// Guard against the migration ever silently dropping ALTER-added columns
// from existing-install rows. Seed a sessions row with values in every
// column that's been added via ALTER in the project history, run initDb,
// and assert the values survive.
describe("sessions migration — ALTER-added column preservation", () => {
  it("preserves cwd/assignment_mode/project_id and other ALTER-added column values", () => {
    const dir = mkdtempSync(join(tmpdir(), "oyster-test-"));
    const dbPath = join(dir, "oyster.db");

    // Hand-build a sessions table matching what an existing install looks
    // like RIGHT BEFORE the migration runs (post-rename, pre-this-change):
    //   - state CHECK has four values (no 'dormant')
    //   - all the ALTER-added columns exist with their declared types
    {
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE sessions (
          id            TEXT PRIMARY KEY,
          space_id      TEXT,
          agent         TEXT NOT NULL CHECK (agent IN ('claude-code','opencode','codex')),
          title         TEXT,
          state         TEXT NOT NULL CHECK (state IN ('active','waiting','disconnected','done')),
          started_at    TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at      TEXT,
          model         TEXT,
          last_event_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_offset   INTEGER NOT NULL DEFAULT 0
        );
      `);
      // Replay every ALTER currently in db.ts that adds a column to sessions.
      // If db.ts grows more ALTERs in future, add them here too.
      const alters = [
        "ALTER TABLE sessions ADD COLUMN cwd TEXT",
        "ALTER TABLE sessions ADD COLUMN assignment_mode TEXT NOT NULL DEFAULT 'auto' CHECK (assignment_mode IN ('auto','manual'))",
        "ALTER TABLE sessions ADD COLUMN project_id TEXT",
        "ALTER TABLE sessions ADD COLUMN sync_dirty_at INTEGER",
        "ALTER TABLE sessions ADD COLUMN cloud_synced_at INTEGER",
        "ALTER TABLE sessions ADD COLUMN cloud_owner_id TEXT",
        "ALTER TABLE sessions ADD COLUMN jsonl_synced_at INTEGER",
        "ALTER TABLE sessions ADD COLUMN jsonl_snapshot_offset INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sessions ADD COLUMN jsonl_chunk_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sessions ADD COLUMN bytes_generation INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sessions ADD COLUMN jsonl_path TEXT",
        "ALTER TABLE sessions ADD COLUMN terminal_id TEXT",
        "ALTER TABLE sessions ADD COLUMN terminal_attached_clients INTEGER NOT NULL DEFAULT 0",
      ];
      for (const sql of alters) {
        try { raw.exec(sql); } catch { /* column already exists or was retired */ }
      }
      raw.prepare(`
        INSERT INTO sessions (
          id, agent, title, state, last_event_at,
          cwd, assignment_mode, project_id, jsonl_path, terminal_id
        ) VALUES (
          's1', 'claude-code', 'test', 'active', datetime('now'),
          '/some/cwd', 'manual', 'proj-abc', '/tmp/abc.jsonl', 'term-xyz'
        )
      `).run();
      raw.close();
    }

    // Run real init.
    const db = initDb(dir);
    const row = db.prepare("SELECT * FROM sessions WHERE id = 's1'").get() as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row.cwd).toBe("/some/cwd");
    expect(row.assignment_mode).toBe("manual");
    expect(row.project_id).toBe("proj-abc");
    expect(row.jsonl_path).toBe("/tmp/abc.jsonl");
    // terminal_id is reset to NULL on boot by the stale-indicator reset
    // (PTYs are in-memory only; they don't survive a restart). The point
    // of this regression guard is that the *column itself* and rows are
    // preserved — not that values pass through unchanged. Assert the
    // column exists by reading it (would throw if dropped).
    expect(Object.prototype.hasOwnProperty.call(row, "terminal_id")).toBe(true);
  });
});
