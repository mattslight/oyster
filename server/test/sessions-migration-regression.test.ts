import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

// Guard against the state-rename rebuild silently dropping additive
// ALTER-added columns from legacy-shape installs. If `needsMigrate` fires
// (sessions CHECK still contains 'running'/'awaiting', or dependent FKs
// reference the phantom `sessions_old` table from the broken intermediate
// migration), `initDb` drops + recreates the sessions table. We need to
// make sure that on a real rebuild path:
//   - the row survives,
//   - state is remapped from 'running' → 'active',
//   - the additive ALTER-added columns (the new status-evidence facts as
//     well as the older cwd / assignment_mode / project_id family) all
//     end up on the rebuilt table.
//
// Caveat: the rebuild's INSERT projection only carries the original
// columns forward — cwd/assignment_mode/project_id/exit_code/... live
// purely in post-rebuild ALTERs, so we don't and can't assert their
// *values* round-trip. The rebuild only ever fires on installs old
// enough that those columns didn't exist at seed time anyway.
describe("sessions migration — rebuild path", () => {
  it("rebuild remaps state, preserves the row, and ends with new + existing ALTER columns present", () => {
    const dir = mkdtempSync(join(tmpdir(), "oyster-test-"));
    const dbPath = join(dir, "oyster.db");

    // Seed a sessions table in the pre-rename shape: state CHECK uses
    // the legacy 'running'/'awaiting' names, and the row's state is
    // 'running'. This is what triggers `needsMigrate` inside initDb.
    {
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE sessions (
          id            TEXT PRIMARY KEY,
          space_id      TEXT,
          agent         TEXT NOT NULL CHECK (agent IN ('claude-code','opencode','codex')),
          title         TEXT,
          state         TEXT NOT NULL CHECK (state IN ('running','awaiting','disconnected','done')),
          started_at    TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at      TEXT,
          model         TEXT,
          last_event_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_offset   INTEGER NOT NULL DEFAULT 0
        );
      `);
      raw.prepare(`
        INSERT INTO sessions (id, agent, title, state, last_event_at)
        VALUES ('s1', 'claude-code', 'test', 'running', datetime('now'))
      `).run();
      raw.close();
    }

    // Run real init. needsMigrate should fire because the seeded CHECK
    // contains 'running'.
    const db = initDb(dir);
    const row = db
      .prepare("SELECT * FROM sessions WHERE id = 's1'")
      .get() as Record<string, unknown>;

    // Row survived the rebuild.
    expect(row).toBeDefined();
    expect(row.id).toBe("s1");

    // state was remapped by the rebuild's CASE statement. If the
    // rebuild block didn't run, state would still be 'running' — so
    // this assertion doubles as proof that we exercised the rebuild
    // path, not the no-op path.
    expect(row.state).toBe("active");

    // New status-evidence fact columns from this PR.
    expect(row).toHaveProperty("exit_code");
    expect(row).toHaveProperty("exit_signal");
    expect(row).toHaveProperty("explicit_exit_seen");
    expect(row).toHaveProperty("clean_process_exit");
    expect(row).toHaveProperty("last_assistant_stop_reason");

    // Pre-existing post-rebuild ALTER-added columns. These are added
    // by ALTERs that run AFTER the rebuild block, so they should be
    // present on the rebuilt table.
    expect(row).toHaveProperty("cwd");
    expect(row).toHaveProperty("assignment_mode");
    expect(row).toHaveProperty("project_id");
    expect(row).toHaveProperty("jsonl_path");

    // terminal_id is reset to NULL on boot by the stale-indicator
    // reset (PTYs are in-memory only and don't survive a restart).
    expect(row.terminal_id).toBeNull();
  });
});
