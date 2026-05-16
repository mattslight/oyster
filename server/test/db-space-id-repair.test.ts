// Repair migration for the inconsistency where a session has a valid
// project_id but a stale (NULL or different) space_id. Came up after an
// UPDATE-FROM order bug in an earlier ad-hoc dedup SQL silently set
// space_id to NULL while moving sessions between merged projects. The
// FK can't enforce "space_id must equal projects.space_id" — that's
// app-level consistency, so the migration heals it at boot.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

describe("initDb space_id repair", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "oyster-repair-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("syncs sessions.space_id from project's space when they disagree (NULL case)", () => {
    const db = initDb(dir);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('oyster', 'Oyster', '#000', 'none')`);
    db.exec(`INSERT INTO projects (id, space_id, name) VALUES ('11111111-1111-1111-1111-111111111111', 'oyster', 'Proj')`);
    // The bad state: project_id set, space_id NULL — orphan in UI even
    // though the binding to the project is valid.
    db.exec(`INSERT INTO sessions (id, agent, state, cwd, project_id, space_id) VALUES ('s', 'claude-code', 'done', '/foo', '11111111-1111-1111-1111-111111111111', NULL)`);
    db.close();

    // Re-open → migrations run → repair fires
    const db2 = initDb(dir);
    const row = db2.prepare("SELECT space_id FROM sessions WHERE id = 's'").get() as { space_id: string };
    expect(row.space_id).toBe("oyster");
    db2.close();
  });

  it("syncs artefacts.space_id from project's space too (stale-space case)", () => {
    const db = initDb(dir);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('home', 'Home', '#000', 'none')`);
    db.exec(`INSERT INTO projects (id, space_id, name) VALUES ('22222222-2222-2222-2222-222222222222', 'work', 'Proj')`);
    // Stale space — project moved to 'work' but artefact still points 'home'.
    // (artifacts.space_id is NOT NULL, so the bad-state we repair is a
    // stale value rather than NULL.)
    db.exec(`INSERT INTO artifacts (id, space_id, label, artifact_kind, storage_kind, runtime_kind, project_id) VALUES ('a', 'home', 'l', 'notes', 'filesystem', 'static_file', '22222222-2222-2222-2222-222222222222')`);
    db.close();

    const db2 = initDb(dir);
    const row = db2.prepare("SELECT space_id FROM artifacts WHERE id = 'a'").get() as { space_id: string };
    expect(row.space_id).toBe("work");
    db2.close();
  });

  it("leaves space_id alone when project is soft-deleted (don't re-bind to a tombstone)", () => {
    const db = initDb(dir);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('oyster', 'Oyster', '#000', 'none')`);
    db.exec(`INSERT INTO projects (id, space_id, name, removed_at) VALUES ('33333333-3333-3333-3333-333333333333', 'oyster', 'Dead', datetime('now'))`);
    db.exec(`INSERT INTO sessions (id, agent, state, cwd, project_id, space_id) VALUES ('s', 'claude-code', 'done', '/foo', '33333333-3333-3333-3333-333333333333', NULL)`);
    db.close();

    const db2 = initDb(dir);
    const row = db2.prepare("SELECT space_id FROM sessions WHERE id = 's'").get() as { space_id: string | null };
    expect(row.space_id).toBeNull(); // unchanged
    db2.close();
  });
});
