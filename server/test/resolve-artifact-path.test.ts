// resolveArtifactPathViaProjects — when an artefact's stored path goes
// missing (folder rename / move), find the file's new location by
// leveraging the project_paths cache. Walks up the stored path looking
// for an ancestor that's known as a project's cached folder, then tries
// the same relative remainder under each of that project's OTHER cached
// paths. Returns the first match (or null when ambiguous / nothing
// matches).
//
// Same primitive lookupProject uses for sessions, applied at the artefact
// granularity so artefact identity stops being tied to absolute paths.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import { resolveArtifactPathViaProjects } from "../src/resolve-artifact-path.js";

const A_UUID = "11111111-2222-3333-4444-555555555555";

describe("resolveArtifactPathViaProjects", () => {
  let userland: string;
  let db: Database.Database;

  beforeEach(() => {
    userland = mkdtempSync(join(tmpdir(), "oyster-rapvp-"));
    db = initDb(userland);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    db.prepare(`INSERT INTO projects (id, space_id, name) VALUES (?, 'work', 'Proj')`).run(A_UUID);
  });
  afterEach(() => { db.close(); rmSync(userland, { recursive: true, force: true }); });

  function seedPath(projectId: string, path: string) {
    db.prepare("INSERT INTO project_paths (project_id, path) VALUES (?, ?)").run(projectId, path);
  }

  it("returns null when no ancestor of the path is in project_paths", () => {
    seedPath(A_UUID, "/some/other/folder");
    const result = resolveArtifactPathViaProjects(db, "/totally/unrelated/file.md");
    expect(result).toBeNull();
  });

  it("returns the new path + projectId when the relative remainder exists under a sibling cached path", () => {
    const oldFolder = mkdtempSync(join(tmpdir(), "oyster-rapvp-old-"));
    const newFolder = mkdtempSync(join(tmpdir(), "oyster-rapvp-new-"));
    mkdirSync(join(newFolder, "docs"), { recursive: true });
    writeFileSync(join(newFolder, "docs", "readme.md"), "ok");
    seedPath(A_UUID, oldFolder);
    seedPath(A_UUID, newFolder);

    const result = resolveArtifactPathViaProjects(db, join(oldFolder, "docs", "readme.md"));
    expect(result).toEqual({ newPath: join(newFolder, "docs", "readme.md"), projectId: A_UUID });

    rmSync(oldFolder, { recursive: true, force: true });
    rmSync(newFolder, { recursive: true, force: true });
  });

  it("returns null when the ancestor matches but no sibling has the relative remainder", () => {
    const oldFolder = mkdtempSync(join(tmpdir(), "oyster-rapvp-old-"));
    const newFolder = mkdtempSync(join(tmpdir(), "oyster-rapvp-new-"));
    // newFolder exists but doesn't contain `docs/missing.md`
    seedPath(A_UUID, oldFolder);
    seedPath(A_UUID, newFolder);

    const result = resolveArtifactPathViaProjects(db, join(oldFolder, "docs", "missing.md"));
    expect(result).toBeNull();

    rmSync(oldFolder, { recursive: true, force: true });
    rmSync(newFolder, { recursive: true, force: true });
  });

  it("returns null when multiple sibling paths contain the same relative remainder (ambiguous)", () => {
    const oldFolder = mkdtempSync(join(tmpdir(), "oyster-rapvp-old-"));
    const new1 = mkdtempSync(join(tmpdir(), "oyster-rapvp-new1-"));
    const new2 = mkdtempSync(join(tmpdir(), "oyster-rapvp-new2-"));
    for (const f of [new1, new2]) {
      mkdirSync(join(f, "docs"), { recursive: true });
      writeFileSync(join(f, "docs", "x.md"), "ok");
    }
    seedPath(A_UUID, oldFolder);
    seedPath(A_UUID, new1);
    seedPath(A_UUID, new2);

    const result = resolveArtifactPathViaProjects(db, join(oldFolder, "docs", "x.md"));
    expect(result).toBeNull();

    rmSync(oldFolder, { recursive: true, force: true });
    rmSync(new1, { recursive: true, force: true });
    rmSync(new2, { recursive: true, force: true });
  });

  it("returns the deepest ancestor's project when nested project paths overlap", () => {
    // Outer project at /a, inner project at /a/inner. An artefact at
    // /a/inner/file.md should resolve via the INNER project's other
    // paths, not the outer's.
    const B_UUID = "99999999-aaaa-bbbb-cccc-dddddddddddd";
    db.prepare(`INSERT INTO projects (id, space_id, name) VALUES (?, 'work', 'Inner')`).run(B_UUID);
    const innerOld = mkdtempSync(join(tmpdir(), "oyster-rapvp-inner-old-"));
    const innerNew = mkdtempSync(join(tmpdir(), "oyster-rapvp-inner-new-"));
    writeFileSync(join(innerNew, "file.md"), "ok");
    seedPath(A_UUID, "/some/outer");                          // outer project
    seedPath(B_UUID, innerOld);                               // inner old path
    seedPath(B_UUID, innerNew);                               // inner new path

    const result = resolveArtifactPathViaProjects(db, join(innerOld, "file.md"));
    expect(result).toEqual({ newPath: join(innerNew, "file.md"), projectId: B_UUID });

    rmSync(innerOld, { recursive: true, force: true });
    rmSync(innerNew, { recursive: true, force: true });
  });

  it("abstains when the ancestor is cached against two live projects (ambiguous owner)", () => {
    // Two live projects both claim the same path in project_paths.
    // findProjectAtAncestor + the resolver must NOT pick arbitrarily —
    // doing so would silently route the artefact to the wrong project.
    const B_UUID = "22222222-2222-2222-2222-222222222222";
    db.prepare(`INSERT INTO projects (id, space_id, name) VALUES (?, 'work', 'Other')`).run(B_UUID);
    const shared = mkdtempSync(join(tmpdir(), "oyster-rapvp-shared-"));
    const newA = mkdtempSync(join(tmpdir(), "oyster-rapvp-newA-"));
    writeFileSync(join(newA, "x.md"), "ok");
    seedPath(A_UUID, shared);
    seedPath(B_UUID, shared); // same path, two projects
    seedPath(A_UUID, newA);

    const result = resolveArtifactPathViaProjects(db, join(shared, "x.md"));
    expect(result).toBeNull();

    rmSync(shared, { recursive: true, force: true });
    rmSync(newA, { recursive: true, force: true });
  });

  it("skips soft-deleted projects when resolving", () => {
    const oldFolder = mkdtempSync(join(tmpdir(), "oyster-rapvp-sd-old-"));
    const newFolder = mkdtempSync(join(tmpdir(), "oyster-rapvp-sd-new-"));
    writeFileSync(join(newFolder, "f.md"), "ok");
    seedPath(A_UUID, oldFolder);
    seedPath(A_UUID, newFolder);
    db.exec(`UPDATE projects SET removed_at = datetime('now') WHERE id = '${A_UUID}'`);

    const result = resolveArtifactPathViaProjects(db, join(oldFolder, "f.md"));
    expect(result).toBeNull(); // don't reattach to a tombstone

    rmSync(oldFolder, { recursive: true, force: true });
    rmSync(newFolder, { recursive: true, force: true });
  });
});
