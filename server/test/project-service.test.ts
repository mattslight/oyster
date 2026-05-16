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

  it("flags hasLivePath: true + exposes recentPath when the most-recent cached path exists", () => {
    const folder = mkdtempSync(join(tmpdir(), "oyster-live-"));
    const proj = service.createProject({ spaceId: "work", name: "Live" });
    db.prepare("INSERT INTO project_paths (project_id, path) VALUES (?, ?)").run(proj.id, folder);

    const [listed] = service.listForSpace("work");
    expect(listed.hasLivePath).toBe(true);
    expect(listed.recentPath).toBe(folder);

    rmSync(folder, { recursive: true, force: true });
  });

  it("flags hasLivePath: false when every cached path is missing on disk (homeless)", () => {
    const proj = service.createProject({ spaceId: "work", name: "Ghost" });
    // Cache a path that doesn't exist — e.g. folder was renamed off-disk.
    db.prepare("INSERT INTO project_paths (project_id, path) VALUES (?, ?)").run(proj.id, "/tmp/this-folder-does-not-exist-" + Math.random());

    const [listed] = service.listForSpace("work");
    expect(listed.hasLivePath).toBe(false);
    expect(listed.recentPath).toBeTruthy();
  });

  it("flags hasLivePath: true when ANY cached path exists (not just the most recent)", () => {
    const liveFolder = mkdtempSync(join(tmpdir(), "oyster-livedup-"));
    const proj = service.createProject({ spaceId: "work", name: "Mixed" });
    // Older path that exists, newer path that's missing — UI should still
    // consider the project live (has an on-disk anchor somewhere).
    db.prepare("INSERT INTO project_paths (project_id, path, last_seen_at) VALUES (?, ?, datetime('now', '-1 hour'))").run(proj.id, liveFolder);
    db.prepare("INSERT INTO project_paths (project_id, path, last_seen_at) VALUES (?, ?, datetime('now'))").run(proj.id, "/tmp/missing-" + Math.random());

    const [listed] = service.listForSpace("work");
    expect(listed.hasLivePath).toBe(true);

    rmSync(liveFolder, { recursive: true, force: true });
  });

  it("flags hasLivePath: false + recentPath: null when no path is cached", () => {
    service.createProject({ spaceId: "work", name: "Naked" });
    const [listed] = service.listForSpace("work");
    expect(listed.hasLivePath).toBe(false);
    expect(listed.recentPath).toBeNull();
  });

  it("flags isGitRepo: true when the project's cached path has a .git entry", () => {
    const repo = mkdtempSync(join(tmpdir(), "oyster-isgit-"));
    mkdirSync(join(repo, ".git"));
    const proj = service.createProject({ spaceId: "work", name: "Repo" });
    db.prepare("INSERT INTO project_paths (project_id, path) VALUES (?, ?)").run(proj.id, repo);

    const [listed] = service.listForSpace("work");
    expect(listed.isGitRepo).toBe(true);

    rmSync(repo, { recursive: true, force: true });
  });

  it("flags isGitRepo: false when path exists but has no .git", () => {
    const folder = mkdtempSync(join(tmpdir(), "oyster-isgit-plain-"));
    const proj = service.createProject({ spaceId: "work", name: "Plain" });
    db.prepare("INSERT INTO project_paths (project_id, path) VALUES (?, ?)").run(proj.id, folder);

    const [listed] = service.listForSpace("work");
    expect(listed.isGitRepo).toBe(false);

    rmSync(folder, { recursive: true, force: true });
  });

  it("flags isGitRepo: false when no path is cached at all", () => {
    service.createProject({ spaceId: "work", name: "Naked" });
    const [listed] = service.listForSpace("work");
    expect(listed.isGitRepo).toBe(false);
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

  it("escapes LIKE wildcards in the cwd — `proj_test` does not claim `projXtest` sessions", () => {
    // `_` and `%` are SQLite LIKE wildcards. A folder named `proj_test`
    // would otherwise produce a prefix `proj_test/%` that matches
    // `projXtest/anything`. Real-world: enough projects use underscores
    // that this would silently misroute sessions.
    const project = service.createProject({ spaceId: "work", name: "Underscore" });
    insertSession("s-exact", "/foo/proj_test");
    insertSession("s-sub", "/foo/proj_test/web");
    insertSession("s-false-positive", "/foo/projXtest/web"); // must NOT match

    const result = service.claimOrphan({ cwd: "/foo/proj_test", projectId: project.id });

    expect(result.claimed).toBe(2);
    const fp = db.prepare("SELECT project_id FROM sessions WHERE id = 's-false-positive'").get() as { project_id: string | null };
    expect(fp.project_id).toBeNull();
  });

  it("handles a cwd of just slashes — does not produce a runaway LIKE that swallows everything", () => {
    const project = service.createProject({ spaceId: "work", name: "Root" });
    insertSession("s-elsewhere", "/foo/bar");

    // Pathological input — attaching `/` shouldn't grab every absolute-path session.
    service.claimOrphan({ cwd: "/", projectId: project.id });

    const row = db.prepare("SELECT project_id FROM sessions WHERE id = 's-elsewhere'").get() as { project_id: string | null };
    expect(row.project_id).toBeNull();
  });

  it("claims sessions whose cwd is a descendant of the project's path (subdirectories)", () => {
    // Old source-shaped binding claimed exact + descendant cwds. The new
    // model must too — sessions started in `<project>/web/src` should
    // attribute to the project attached at `<project>`.
    const project = service.createProject({ spaceId: "work", name: "Proj" });
    insertSession("s-exact", "/foo/bar");
    insertSession("s-sub", "/foo/bar/web");
    insertSession("s-deep", "/foo/bar/web/src");
    insertSession("s-sibling", "/foo/bar-other"); // must NOT match (no slash boundary)

    const result = service.claimOrphan({ cwd: "/foo/bar", projectId: project.id });

    expect(result.claimed).toBe(3);
    const rows = db.prepare("SELECT id, project_id FROM sessions ORDER BY id").all() as Array<{ id: string; project_id: string | null }>;
    expect(rows.find((r) => r.id === "s-exact")?.project_id).toBe(project.id);
    expect(rows.find((r) => r.id === "s-sub")?.project_id).toBe(project.id);
    expect(rows.find((r) => r.id === "s-deep")?.project_id).toBe(project.id);
    expect(rows.find((r) => r.id === "s-sibling")?.project_id).toBeNull();
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

  it("clears project_id on bound sessions so they don't end up FK'd to a tombstone", () => {
    // The FK is ON DELETE SET NULL but only fires on hard deletes; soft-
    // delete used to leave sessions pointing at the removed_at row, which
    // hid them from the project tile but kept them in a weird limbo
    // (space scope still showed them, no project tile claimed them).
    // Cleaner: soft-delete demotes children to true orphans.
    const project = service.createProject({ spaceId: "work", name: "Proj" });
    db.prepare("INSERT INTO sessions (id, agent, state, cwd, project_id, space_id) VALUES ('s1', 'claude-code', 'done', '/foo', ?, 'work')").run(project.id);

    service.deleteProject(project.id);

    const row = db.prepare("SELECT project_id FROM sessions WHERE id = 's1'").get() as { project_id: string | null };
    expect(row.project_id).toBeNull();
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

  it("throws when the project is soft-deleted (so renames don't silently target tombstones)", () => {
    const p = service.createProject({ spaceId: "work", name: "Old" });
    service.deleteProject(p.id);
    expect(() => service.updateProject(p.id, { name: "New" })).toThrow();
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

  it("seeds project_paths immediately so a follow-up attach of the same folder dedupes via cache", () => {
    const folder = mkdtempSync(join(tmpdir(), "oyster-attach-cache-seed-"));
    const { project } = service.attachFolder({ spaceId: "work", path: folder });

    const cached = db
      .prepare("SELECT project_id, path FROM project_paths WHERE project_id = ?")
      .all(project.id) as Array<{ project_id: string; path: string }>;
    expect(cached).toEqual([{ project_id: project.id, path: folder }]);

    rmSync(folder, { recursive: true, force: true });
  });

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

  it("re-attaching a folder whose project was soft-deleted undeletes it (preserves existing session bindings)", () => {
    const folder = mkdtempSync(join(tmpdir(), "oyster-attach-undelete-"));
    // Project exists, marker exists, sessions point at it. Then the user
    // deletes the tile (soft-delete) but `.oyster/id` on disk still names
    // the deleted project. Re-attaching must adopt the SAME id so the
    // historical session bindings still resolve.
    const existing = service.createProject({ spaceId: "work", name: "Pre" });
    mkdirSync(join(folder, ".oyster"));
    writeFileSync(join(folder, ".oyster", "id"), existing.id);
    db.prepare("INSERT INTO sessions (id, agent, state, cwd, project_id) VALUES ('s1', 'claude-code', 'done', ?, ?)").run(folder, existing.id);
    service.deleteProject(existing.id);

    const { project } = service.attachFolder({ spaceId: "work", path: folder });

    expect(project.id).toBe(existing.id);
    // Project is alive again — listForSpace returns it.
    expect(service.listForSpace("work").map((p) => p.id)).toContain(existing.id);
    // The historical session row still resolves to a live project.
    const sessionRow = db.prepare("SELECT project_id FROM sessions WHERE id = 's1'").get() as { project_id: string };
    expect(sessionRow.project_id).toBe(existing.id);

    rmSync(folder, { recursive: true, force: true });
  });

  it("adopts an existing project via project_paths cache when no .oyster/id marker is present (no duplicate)", () => {
    const folder = mkdtempSync(join(tmpdir(), "oyster-attach-cached-"));
    const existing = service.createProject({ spaceId: "work", name: "Pre" });
    db.prepare("INSERT INTO project_paths (project_id, path) VALUES (?, ?)").run(existing.id, folder);
    // No .oyster/id on disk — only the cache row.

    const { project } = service.attachFolder({ spaceId: "work", path: folder });

    // Adopts the existing project rather than creating a new one.
    expect(project.id).toBe(existing.id);
    expect(service.listForSpace("work")).toHaveLength(1);
    // Self-heals the marker for next time.
    const written = readFileSync(join(folder, ".oyster", "id"), "utf8").trim();
    expect(written).toBe(existing.id);

    rmSync(folder, { recursive: true, force: true });
  });

  it("adopts the UUID from .oyster/id even when no matching project row exists locally (cross-device clone)", () => {
    // Scenario: another machine wrote `.oyster/id` (e.g. via git push of the
    // folder); this machine clones the repo, sees the marker, but has no
    // project row with that id. Must NOT mint a new UUID + overwrite the
    // marker — that severs cross-device identity. Adopts the existing id.
    const folder = mkdtempSync(join(tmpdir(), "oyster-attach-foreign-marker-"));
    const FOREIGN_ID = "deadbeef-cafe-babe-1234-aabbccddeeff";
    mkdirSync(join(folder, ".oyster"));
    writeFileSync(join(folder, ".oyster", "id"), FOREIGN_ID);

    const { project } = service.attachFolder({ spaceId: "work", path: folder });

    expect(project.id).toBe(FOREIGN_ID);
    // Marker file unchanged.
    expect(readFileSync(join(folder, ".oyster", "id"), "utf8").trim()).toBe(FOREIGN_ID);
    rmSync(folder, { recursive: true, force: true });
  });

  it("survives a missing folder (writeOysterId failure is non-fatal — project still created)", () => {
    const missing = join(tmpdir(), "oyster-attach-never-existed-" + Math.random());
    db.prepare("INSERT INTO sessions (id, agent, state, cwd) VALUES ('s1', 'claude-code', 'done', ?)").run(missing);

    const { project, claimed } = service.attachFolder({ spaceId: "work", path: missing });

    expect(project.spaceId).toBe("work");
    expect(claimed).toBe(1);
    // No marker on disk (folder doesn't exist) — that's expected, attach
    // succeeded anyway so the orphan-recovery flow has a project to bind to.
  });

  it("re-attaching under a DIFFERENT space moves the undeleted project to the new space (and reclaims sessions there)", () => {
    const folder = mkdtempSync(join(tmpdir(), "oyster-attach-cross-space-"));
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('personal', 'Personal', '#111', 'none')`);
    // Project was created under "work", folder marker still points at it,
    // tile was soft-deleted, user now attaches the same folder under "personal".
    const existing = service.createProject({ spaceId: "work", name: "Pre" });
    mkdirSync(join(folder, ".oyster"));
    writeFileSync(join(folder, ".oyster", "id"), existing.id);
    service.deleteProject(existing.id);
    db.prepare("INSERT INTO sessions (id, agent, state, cwd) VALUES ('s-new', 'claude-code', 'done', ?)").run(folder);

    const { project, claimed } = service.attachFolder({ spaceId: "personal", path: folder });

    expect(project.id).toBe(existing.id);
    expect(project.spaceId).toBe("personal");
    expect(claimed).toBe(1);
    // Project is listed under the new space, not the old one.
    expect(service.listForSpace("personal").map((p) => p.id)).toContain(existing.id);
    expect(service.listForSpace("work").map((p) => p.id)).not.toContain(existing.id);
    // Reclaimed session lands under personal.
    const sessionRow = db.prepare("SELECT space_id FROM sessions WHERE id = 's-new'").get() as { space_id: string };
    expect(sessionRow.space_id).toBe("personal");

    rmSync(folder, { recursive: true, force: true });
  });
});
