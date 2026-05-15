// Retrospective tests for the sources→projects one-shot migration that
// runs on first boot inside `initDb`. The migration introduces three
// invariants the rest of the rewrite depends on:
//
//   1. Every active source becomes exactly one project. Soft-deleted
//      sources are skipped entirely (their sessions stay orphan).
//   2. portable_id (when set) is preserved as projects.id — this is the
//      cross-machine identity anchor. Worktrees and sibling checkouts
//      that share a portable_id collapse to a single project.
//   3. sessions.project_id backfills from source_id, so existing
//      session-source bindings carry over without any data loss.
//
// The migration is idempotent: a project-row presence sentinel prevents
// re-running on subsequent boots.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initDb } from "../src/db.js";

// Pre-migration schema fixture: just enough columns for initDb to find
// what it needs. initDb fills in the rest (projects, project_paths,
// sessions.project_id, indices) on first open.
function seedPreMigration(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE spaces (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, color TEXT,
      scan_status TEXT NOT NULL DEFAULT 'none' CHECK (scan_status IN ('none','scanning','complete','error')),
      scan_error TEXT, last_scanned_at TEXT, last_scan_summary TEXT,
      ai_job_status TEXT CHECK (ai_job_status IS NULL OR ai_job_status IN ('pending','running','complete','error')),
      ai_job_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sources (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'local_folder',
      path TEXT NOT NULL,
      label TEXT,
      portable_id TEXT,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      removed_at TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      space_id TEXT,
      source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
      agent TEXT NOT NULL CHECK (agent IN ('claude-code','opencode','codex')),
      title TEXT,
      state TEXT NOT NULL CHECK (state IN ('active','waiting','disconnected','done')),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      model TEXT,
      last_event_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_offset INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

describe("initDb sources→projects migration", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "oyster-proj-mig-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("creates one project per active source", () => {
    const dbPath = join(dir, "oyster.db");
    const seed = seedPreMigration(dbPath);
    seed.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    seed.prepare("INSERT INTO sources (id, space_id, path, label, portable_id, added_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      "src-1", "work", "/a/proj-one", "Project One", null, "2026-01-01T00:00:00Z",
    );
    seed.prepare("INSERT INTO sources (id, space_id, path, label, portable_id, added_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      "src-2", "work", "/a/proj-two", null, null, "2026-01-02T00:00:00Z",
    );
    seed.close();

    const db = initDb(dir);
    const projects = db.prepare("SELECT id, space_id, name, created_at FROM projects ORDER BY created_at").all() as Array<{ id: string; space_id: string; name: string; created_at: string }>;
    expect(projects).toHaveLength(2);
    expect(projects[0]).toMatchObject({ space_id: "work", name: "Project One", created_at: "2026-01-01T00:00:00Z" });
    expect(projects[1]).toMatchObject({ space_id: "work", name: "proj-two", created_at: "2026-01-02T00:00:00Z" });
  });

  it("preserves portable_id as projects.id when set", () => {
    const dbPath = join(dir, "oyster.db");
    const seed = seedPreMigration(dbPath);
    seed.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    seed.prepare("INSERT INTO sources (id, space_id, path, label, portable_id) VALUES (?, ?, ?, ?, ?)").run(
      "src-1", "work", "/a/proj", "Proj", "11111111-2222-3333-4444-555555555555",
    );
    seed.close();

    const db = initDb(dir);
    const row = db.prepare("SELECT id FROM projects").get() as { id: string };
    expect(row.id).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("mints a fresh UUID when portable_id is NULL", () => {
    const dbPath = join(dir, "oyster.db");
    const seed = seedPreMigration(dbPath);
    seed.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    seed.prepare("INSERT INTO sources (id, space_id, path, portable_id) VALUES ('src-1', 'work', '/a/proj', NULL)").run();
    seed.close();

    const db = initDb(dir);
    const row = db.prepare("SELECT id FROM projects").get() as { id: string };
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("collapses worktrees (sources sharing a portable_id) to a single project", () => {
    const dbPath = join(dir, "oyster.db");
    const seed = seedPreMigration(dbPath);
    seed.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    const pid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    seed.prepare("INSERT INTO sources (id, space_id, path, label, portable_id, added_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      "src-main", "work", "/a/proj", "Proj", pid, "2026-01-01T00:00:00Z",
    );
    seed.prepare("INSERT INTO sources (id, space_id, path, label, portable_id, added_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      "src-wt", "work", "/a/proj-wt", "Proj WT", pid, "2026-01-02T00:00:00Z",
    );
    seed.close();

    const db = initDb(dir);
    const projects = db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>;
    expect(projects).toHaveLength(1);
    expect(projects[0]!.id).toBe(pid);
    // But both source paths cache to project_paths.
    const paths = db.prepare("SELECT path FROM project_paths WHERE project_id = ? ORDER BY path").all(pid) as Array<{ path: string }>;
    expect(paths.map((p) => p.path)).toEqual(["/a/proj", "/a/proj-wt"]);
  });

  it("skips soft-deleted sources", () => {
    const dbPath = join(dir, "oyster.db");
    const seed = seedPreMigration(dbPath);
    seed.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    seed.prepare("INSERT INTO sources (id, space_id, path, removed_at) VALUES ('alive', 'work', '/a/alive', NULL)").run();
    seed.prepare("INSERT INTO sources (id, space_id, path, removed_at) VALUES ('dead', 'work', '/a/dead', '2026-01-01 00:00:00')").run();
    seed.close();

    const db = initDb(dir);
    const projects = db.prepare("SELECT name FROM projects").all() as Array<{ name: string }>;
    expect(projects.map((p) => p.name)).toEqual(["alive"]);
  });

  it("backfills sessions.project_id from source_id", () => {
    const dbPath = join(dir, "oyster.db");
    const seed = seedPreMigration(dbPath);
    seed.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    const pid = "feedface-cafe-babe-dead-beefdeadbeef";
    seed.prepare("INSERT INTO sources (id, space_id, path, portable_id) VALUES ('src-1', 'work', '/a/proj', ?)").run(pid);
    seed.prepare("INSERT INTO sessions (id, space_id, source_id, agent, state) VALUES (?, ?, ?, ?, ?)").run(
      "sess-1", "work", "src-1", "claude-code", "done",
    );
    seed.prepare("INSERT INTO sessions (id, source_id, agent, state) VALUES (?, ?, ?, ?)").run(
      "sess-2", null, "claude-code", "done", // orphan; stays orphan
    );
    seed.close();

    const db = initDb(dir);
    const sessions = db.prepare("SELECT id, project_id FROM sessions ORDER BY id").all() as Array<{ id: string; project_id: string | null }>;
    expect(sessions.find((s) => s.id === "sess-1")?.project_id).toBe(pid);
    expect(sessions.find((s) => s.id === "sess-2")?.project_id).toBeNull();
  });

  it("seeds project_paths from active sources only", () => {
    const dbPath = join(dir, "oyster.db");
    const seed = seedPreMigration(dbPath);
    seed.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    seed.prepare("INSERT INTO sources (id, space_id, path, removed_at) VALUES ('alive', 'work', '/a/alive', NULL)").run();
    seed.prepare("INSERT INTO sources (id, space_id, path, removed_at) VALUES ('dead', 'work', '/a/dead', '2026-01-01 00:00:00')").run();
    seed.close();

    const db = initDb(dir);
    const paths = db.prepare("SELECT path FROM project_paths").all() as Array<{ path: string }>;
    expect(paths.map((p) => p.path)).toEqual(["/a/alive"]);
  });

  it("is idempotent on repeat boot", () => {
    const dbPath = join(dir, "oyster.db");
    const seed = seedPreMigration(dbPath);
    seed.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    seed.prepare("INSERT INTO sources (id, space_id, path, portable_id) VALUES ('src-1', 'work', '/a/proj', NULL)").run();
    seed.close();

    const db1 = initDb(dir);
    const before = db1.prepare("SELECT id, name FROM projects").all();
    db1.close();
    const db2 = initDb(dir);
    const after = db2.prepare("SELECT id, name FROM projects").all();
    expect(after).toEqual(before);
  });
});
