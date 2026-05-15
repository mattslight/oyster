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
    db.exec(`INSERT INTO projects (id, space_id, name) VALUES ('p-1', 'work', 'Proj')`);

    const store = new SqliteSessionStore(db);
    store.upsertSession({
      id: "sess-1",
      space_id: "work",
      project_id: "p-1",
      agent: "claude-code",
      state: "active",
    });

    const row = db.prepare("SELECT project_id FROM sessions WHERE id = ?").get("sess-1") as { project_id: string | null };
    expect(row.project_id).toBe("p-1");
  });
});
