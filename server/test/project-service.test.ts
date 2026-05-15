// ProjectService — the business surface that replaces the source-shaped
// halves of SpaceService (addSource, updateSource, consolidateSource,
// removeSource). A project has an identity (id == .oyster/id when one is
// written to disk; fresh UUID otherwise), a name, and a parent space.
// Folder paths are *advisory cache* in `project_paths`, never authority.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import { ProjectService } from "../src/project-service.js";

describe("ProjectService.createProject", () => {
  let dir: string;
  let db: Database.Database;
  let service: ProjectService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oyster-ps-"));
    db = initDb(dir);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    service = new ProjectService(db);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("creates a project row in the given space and returns it", () => {
    const project = service.createProject({ spaceId: "work", name: "My Project" });
    expect(project.spaceId).toBe("work");
    expect(project.name).toBe("My Project");
    expect(project.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const row = db.prepare("SELECT id, space_id, name FROM projects WHERE id = ?").get(project.id);
    expect(row).toEqual({ id: project.id, space_id: "work", name: "My Project" });
  });
});

describe("ProjectService.listForSpace", () => {
  let dir: string;
  let db: Database.Database;
  let service: ProjectService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oyster-ps-list-"));
    db = initDb(dir);
    db.exec(`
      INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none');
      INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('home', 'Home', '#111', 'none');
    `);
    service = new ProjectService(db);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("returns active projects in the given space, sorted by name", () => {
    service.createProject({ spaceId: "work", name: "Zebra" });
    service.createProject({ spaceId: "work", name: "Alpha" });
    service.createProject({ spaceId: "home", name: "Sidetrack" });

    const projects = service.listForSpace("work");
    expect(projects.map((p) => p.name)).toEqual(["Alpha", "Zebra"]);
  });

  it("excludes soft-deleted projects", () => {
    const alive = service.createProject({ spaceId: "work", name: "Alive" });
    const dead = service.createProject({ spaceId: "work", name: "Dead" });
    db.prepare("UPDATE projects SET removed_at = datetime('now') WHERE id = ?").run(dead.id);

    const projects = service.listForSpace("work");
    expect(projects.map((p) => p.id)).toEqual([alive.id]);
  });
});

describe("ProjectService.claimOrphan", () => {
  let dir: string;
  let db: Database.Database;
  let service: ProjectService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oyster-ps-claim-"));
    db = initDb(dir);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    service = new ProjectService(db);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  function insertSession(id: string, cwd: string | null, projectId: string | null = null) {
    db.prepare(
      "INSERT INTO sessions (id, agent, state, cwd, project_id) VALUES (?, 'claude-code', 'done', ?, ?)",
    ).run(id, cwd, projectId);
  }

  it("tags orphan sessions matching the cwd with the given project", () => {
    const project = service.createProject({ spaceId: "work", name: "Proj" });
    insertSession("s1", "/foo/bar");
    insertSession("s2", "/foo/bar");
    insertSession("s3", "/other");

    const result = service.claimOrphan({ cwd: "/foo/bar", projectId: project.id });

    expect(result.claimed).toBe(2);
    const rows = db.prepare("SELECT id, project_id, space_id FROM sessions ORDER BY id").all() as Array<{ id: string; project_id: string | null; space_id: string | null }>;
    expect(rows.find((r) => r.id === "s1")?.project_id).toBe(project.id);
    expect(rows.find((r) => r.id === "s1")?.space_id).toBe("work");
    expect(rows.find((r) => r.id === "s2")?.project_id).toBe(project.id);
    expect(rows.find((r) => r.id === "s3")?.project_id).toBeNull();
  });

  it("does not touch sessions already bound to any project", () => {
    const project = service.createProject({ spaceId: "work", name: "Proj" });
    const other = service.createProject({ spaceId: "work", name: "Other" });
    insertSession("s-claimed", "/foo", other.id);
    insertSession("s-orphan", "/foo", null);

    const result = service.claimOrphan({ cwd: "/foo", projectId: project.id });

    expect(result.claimed).toBe(1);
    const claimed = db.prepare("SELECT project_id FROM sessions WHERE id = 's-claimed'").get() as { project_id: string };
    expect(claimed.project_id).toBe(other.id); // unchanged
  });

  it("throws when projectId doesn't exist", () => {
    expect(() => service.claimOrphan({ cwd: "/foo", projectId: "nope" })).toThrow();
  });
});

describe("ProjectService.deleteProject", () => {
  let dir: string;
  let db: Database.Database;
  let service: ProjectService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oyster-ps-del-"));
    db = initDb(dir);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    service = new ProjectService(db);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("soft-deletes the project (sets removed_at) so listForSpace stops returning it", () => {
    const p = service.createProject({ spaceId: "work", name: "Proj" });
    service.deleteProject(p.id);
    expect(service.listForSpace("work")).toEqual([]);
    // Row still exists in the DB — sessions FK-pointing at it stay valid.
    const row = db.prepare("SELECT removed_at FROM projects WHERE id = ?").get(p.id) as { removed_at: string };
    expect(row.removed_at).not.toBeNull();
  });

  it("throws when the project doesn't exist", () => {
    expect(() => service.deleteProject("nope")).toThrow();
  });
});

describe("ProjectService.updateProject", () => {
  let dir: string;
  let db: Database.Database;
  let service: ProjectService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oyster-ps-up-"));
    db = initDb(dir);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    service = new ProjectService(db);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("renames the project", () => {
    const p = service.createProject({ spaceId: "work", name: "Old" });
    const updated = service.updateProject(p.id, { name: "New" });
    expect(updated.name).toBe("New");
    expect(service.listForSpace("work").map((x) => x.name)).toEqual(["New"]);
  });

  it("rejects an empty name", () => {
    const p = service.createProject({ spaceId: "work", name: "Old" });
    expect(() => service.updateProject(p.id, { name: "  " })).toThrow();
  });
});

describe("ProjectService.attachFolder", () => {
  let dir: string;
  let db: Database.Database;
  let service: ProjectService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oyster-ps-attach-"));
    db = initDb(dir);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    service = new ProjectService(db);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("creates a project named after the folder basename, writes .oyster/id, and claims orphans", () => {
    const folder = mkdtempSync(join(tmpdir(), "oyster-attach-target-"));
    db.prepare("INSERT INTO sessions (id, agent, state, cwd) VALUES ('s1', 'claude-code', 'done', ?)").run(folder);

    const { project, claimed } = service.attachFolder({ spaceId: "work", path: folder });

    expect(project.spaceId).toBe("work");
    expect(project.name).toBe(folder.split("/").filter(Boolean).pop());
    expect(claimed).toBe(1);

    // .oyster/id was written with the project's UUID.
    const written = readFileSync(join(folder, ".oyster", "id"), "utf8").trim();
    expect(written).toBe(project.id);

    // Orphan session claimed.
    const row = db.prepare("SELECT project_id, space_id FROM sessions WHERE id = 's1'").get() as { project_id: string; space_id: string };
    expect(row.project_id).toBe(project.id);
    expect(row.space_id).toBe("work");

    rmSync(folder, { recursive: true, force: true });
  });

  it("accepts an explicit name and uses it instead of the basename", () => {
    const folder = mkdtempSync(join(tmpdir(), "oyster-attach-named-"));
    const { project } = service.attachFolder({ spaceId: "work", path: folder, name: "Custom Name" });
    expect(project.name).toBe("Custom Name");
    rmSync(folder, { recursive: true, force: true });
  });

  it("respects an existing .oyster/id (adopts the existing project id rather than creating a duplicate)", () => {
    const folder = mkdtempSync(join(tmpdir(), "oyster-attach-existing-"));
    // Pre-existing project with marker on disk.
    const existing = service.createProject({ spaceId: "work", name: "Pre" });
    mkdirSync(join(folder, ".oyster"));
    writeFileSync(join(folder, ".oyster", "id"), existing.id);

    const { project, claimed } = service.attachFolder({ spaceId: "work", path: folder });

    expect(project.id).toBe(existing.id);
    expect(claimed).toBe(0);
    // Did not create a second project row.
    expect(service.listForSpace("work")).toHaveLength(1);

    rmSync(folder, { recursive: true, force: true });
  });
});
