// Drives the addition of `project_id` to the session-store's upsert path.
// The watcher will pass project_id (resolved via lookupProject) on every
// upsert so new sessions tag with the new identity directly. This test
// pins the persistence contract — without it the watcher could call
// upsertSession with project_id and have it silently dropped at the
// SQL layer.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";

describe("SqliteSessionStore.upsertSession (project_id)", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "oyster-ss-pid-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("persists project_id when provided on insert", () => {
    const db = initDb(dir);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    db.exec(`INSERT INTO projects (id, space_id, name) VALUES ('11111111-1111-1111-1111-111111111111', 'work', 'Proj')`);

    const store = new SqliteSessionStore(db);
    store.upsertSession({
      id: "sess-1",
      space_id: "work",
      project_id: "11111111-1111-1111-1111-111111111111",
      agent: "claude-code",
      state: "active",
    });

    const row = db.prepare("SELECT project_id FROM sessions WHERE id = ?").get("sess-1") as { project_id: string | null };
    expect(row.project_id).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("upsert does NOT clobber an existing non-null project_id with NULL (boot-scan resilience)", () => {
    // Scenario: a session was bound to a project via claim_orphan / attach,
    // then on restart the watcher's boot scan calls upsertSession with the
    // result of lookupProject(cwd). If the folder has no `.oyster/id` and
    // no project_paths cache row, lookupProject returns NONE — upsert sees
    // project_id=NULL in `excluded` and (in 'auto' mode) would have OVERWRITTEN
    // the existing binding. That's the bug that produced the user's duplicates
    // after restart. Keep the existing non-null value instead.
    const db = initDb(dir);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    db.exec(`INSERT INTO projects (id, space_id, name) VALUES ('22222222-2222-2222-2222-222222222222', 'work', 'Proj')`);

    const store = new SqliteSessionStore(db);
    // First write: session bound to project (e.g. via claimOrphan).
    store.upsertSession({
      id: "sess-2",
      space_id: "work",
      project_id: "22222222-2222-2222-2222-222222222222",
      agent: "claude-code",
      state: "active",
    });
    // Second write: watcher's boot scan — lookupProject returned NULL.
    store.upsertSession({
      id: "sess-2",
      space_id: null,
      project_id: null,
      agent: "claude-code",
      state: "active",
    });

    const row = db.prepare("SELECT project_id, space_id FROM sessions WHERE id = ?").get("sess-2") as { project_id: string | null; space_id: string | null };
    expect(row.project_id).toBe("22222222-2222-2222-2222-222222222222");
    expect(row.space_id).toBe("work");
  });
});
