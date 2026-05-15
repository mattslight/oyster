// lookupProject — given a cwd, read `<cwd>/.oyster/id` and resolve it
// to a project + space from the DB. The watcher calls this at session
// ingest time to tag sessions directly, replacing the longest-prefix
// path scan against `sources`.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import { lookupProject } from "../src/lookup-project.js";

const A_UUID = "11111111-2222-3333-4444-555555555555";

describe("lookupProject", () => {
  let userland: string;
  let cwd: string;
  let db: Database.Database;

  beforeEach(() => {
    userland = mkdtempSync(join(tmpdir(), "oyster-lp-userland-"));
    cwd = mkdtempSync(join(tmpdir(), "oyster-lp-cwd-"));
    db = initDb(userland);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
  });

  afterEach(() => {
    db.close();
    rmSync(userland, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function writeOysterIdAt(folder: string, id: string) {
    mkdirSync(join(folder, ".oyster"), { recursive: true });
    writeFileSync(join(folder, ".oyster", "id"), id + "\n");
  }

  it("returns the project + space when .oyster/id resolves to a live project", () => {
    db.prepare("INSERT INTO projects (id, space_id, name) VALUES (?, ?, ?)").run(A_UUID, "work", "Proj");
    writeOysterIdAt(cwd, A_UUID);

    expect(lookupProject(db, cwd)).toEqual({ projectId: A_UUID, spaceId: "work" });
  });

  it("caches the cwd in project_paths so we know where this project lives on this device", () => {
    db.prepare("INSERT INTO projects (id, space_id, name) VALUES (?, ?, ?)").run(A_UUID, "work", "Proj");
    writeOysterIdAt(cwd, A_UUID);

    lookupProject(db, cwd);

    const paths = db
      .prepare("SELECT path FROM project_paths WHERE project_id = ?")
      .all(A_UUID) as Array<{ path: string }>;
    expect(paths.map((p) => p.path)).toEqual([cwd]);
  });
});
