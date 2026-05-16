// End-to-end integration test for the session-ingest contract:
//   folder with .oyster/id  →  lookupProject(folder)  →  upsertSession
//   →  session row tagged with the right (project_id, space_id).
//
// This is the bug-fix invariant in test form. The watcher in production
// composes these exact calls; here we drive them directly without
// chokidar so the test stays fast and deterministic.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { lookupProject } from "../src/lookup-project.js";

describe("session ingest tags sessions with project_id via .oyster/id", () => {
  let userland: string;
  let folder: string;
  let db: Database.Database;

  beforeEach(() => {
    userland = mkdtempSync(join(tmpdir(), "oyster-ingest-userland-"));
    folder = mkdtempSync(join(tmpdir(), "oyster-ingest-folder-"));
    db = initDb(userland);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
  });

  afterEach(() => {
    db.close();
    rmSync(userland, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  it("happy path: session in a folder with .oyster/id pointing at a live project tags correctly", () => {
    db.prepare("INSERT INTO projects (id, space_id, name) VALUES ('11111111-2222-3333-4444-555555555555', 'work', 'Proj')").run();
    mkdirSync(join(folder, ".oyster"), { recursive: true });
    writeFileSync(join(folder, ".oyster", "id"), "11111111-2222-3333-4444-555555555555\n");

    const project = lookupProject(db, folder);
    const store = new SqliteSessionStore(db);
    store.upsertSession({
      id: "sess-1",
      space_id: project.spaceId,
      project_id: project.projectId,
      cwd: folder,
      agent: "claude-code",
      state: "active",
    });

    const row = db.prepare("SELECT project_id, space_id FROM sessions WHERE id = ?").get("sess-1") as { project_id: string; space_id: string };
    expect(row.project_id).toBe("11111111-2222-3333-4444-555555555555");
    expect(row.space_id).toBe("work");
  });

  it("orphan path: session in a folder with no .oyster/id and no cached project ends up unattributed", () => {
    const project = lookupProject(db, folder);
    expect(project).toEqual({ projectId: null, spaceId: null });

    const store = new SqliteSessionStore(db);
    store.upsertSession({
      id: "sess-2",
      space_id: project.spaceId,
      project_id: project.projectId,
      cwd: folder,
      agent: "claude-code",
      state: "active",
    });

    const row = db.prepare("SELECT project_id, space_id FROM sessions WHERE id = ?").get("sess-2") as { project_id: string | null; space_id: string | null };
    expect(row.project_id).toBeNull();
    expect(row.space_id).toBeNull();
  });

  it("recovery path: .oyster/id deleted but project_paths cache still claims the folder — session tags + marker self-heals", () => {
    // The cache row exists from a prior session ingest in this folder.
    // The user has since deleted .oyster/; a new session here would orphan
    // under the naive read. With the fallback, the binding recovers and
    // the marker is rewritten so subsequent reads go through the happy path.
    db.prepare("INSERT INTO projects (id, space_id, name) VALUES ('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'work', 'Proj')").run();
    db.prepare("INSERT INTO project_paths (project_id, path) VALUES ('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', ?)").run(folder);

    const project = lookupProject(db, folder);
    expect(project).toEqual({ projectId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", spaceId: "work" });

    // Marker self-healed on disk.
    expect(readFileSync(join(folder, ".oyster", "id"), "utf8").trim()).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

    const store = new SqliteSessionStore(db);
    store.upsertSession({
      id: "sess-3",
      space_id: project.spaceId,
      project_id: project.projectId,
      cwd: folder,
      agent: "claude-code",
      state: "active",
    });
    const row = db.prepare("SELECT project_id FROM sessions WHERE id = ?").get("sess-3") as { project_id: string };
    expect(row.project_id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });
});
