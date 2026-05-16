// ArtifactService.getAllArtifacts self-heal: when a filesystem-backed
// artefact's stored path is missing on disk, we used to soft-delete the
// row outright. That tombstoned artefacts on every folder rename — the
// same path-fragility problem the projects refactor fixed for sessions.
// Now we try `resolveArtifactPathViaProjects` first; if the file moved
// with the rename (still findable under another cached path of the same
// project), the row gets its path + projectId updated in-place instead.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import { ArtifactService } from "../src/artifact-service.js";
import { SqliteArtifactStore } from "../src/artifact-store.js";

const PROJ_ID = "11111111-2222-3333-4444-555555555555";

describe("ArtifactService.getAllArtifacts self-heal — resolver path", () => {
  let userland: string;
  let oldDir: string;
  let newDir: string;
  let db: Database.Database;
  let service: ArtifactService;

  beforeEach(() => {
    userland = mkdtempSync(join(tmpdir(), "oyster-sh-userland-"));
    oldDir = mkdtempSync(join(tmpdir(), "oyster-sh-old-"));
    newDir = mkdtempSync(join(tmpdir(), "oyster-sh-new-"));
    db = initDb(userland);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    db.prepare(`INSERT INTO projects (id, space_id, name) VALUES (?, 'work', 'Proj')`).run(PROJ_ID);
    db.prepare(`INSERT INTO project_paths (project_id, path) VALUES (?, ?)`).run(PROJ_ID, oldDir);
    db.prepare(`INSERT INTO project_paths (project_id, path) VALUES (?, ?)`).run(PROJ_ID, newDir);
    service = new ArtifactService(db, new SqliteArtifactStore(db), "https://oyster.to", "https://share.oyster.to", userland);
  });

  afterEach(() => {
    db.close();
    rmSync(userland, { recursive: true, force: true });
    rmSync(oldDir, { recursive: true, force: true });
    rmSync(newDir, { recursive: true, force: true });
  });

  function seedFilesystemArtifact(id: string, path: string, project_id: string | null = null) {
    db.prepare(
      `INSERT INTO artifacts (id, space_id, label, artifact_kind, storage_kind, storage_config, runtime_kind, runtime_config, project_id)
       VALUES (?, 'work', ?, 'notes', 'filesystem', ?, 'static_file', '{}', ?)`,
    ).run(id, "doc", JSON.stringify({ path }), project_id);
  }

  it("updates the artefact path + project_id when the file is recoverable via project_paths", async () => {
    mkdirSync(join(newDir, "docs"), { recursive: true });
    writeFileSync(join(newDir, "docs", "report.md"), "ok");
    seedFilesystemArtifact("art-1", join(oldDir, "docs", "report.md"));

    const result = await service.getAllArtifacts(() => {});

    // Row survives (NOT tombstoned).
    expect(result.find((a) => a.id === "art-1")).toBeDefined();
    const row = db.prepare("SELECT storage_config, project_id, removed_at FROM artifacts WHERE id = 'art-1'").get() as { storage_config: string; project_id: string | null; removed_at: string | null };
    expect(row.removed_at).toBeNull();
    expect(JSON.parse(row.storage_config)).toEqual({ path: join(newDir, "docs", "report.md") });
    expect(row.project_id).toBe(PROJ_ID); // stamped while we were there
  });

  it("falls back to the old soft-delete behaviour when the resolver returns nothing", async () => {
    // Path is missing AND not recoverable via project_paths (no matching file anywhere).
    seedFilesystemArtifact("art-2", join(oldDir, "totally-gone.md"));

    const result = await service.getAllArtifacts(() => {});

    expect(result.find((a) => a.id === "art-2")).toBeUndefined();
    const row = db.prepare("SELECT removed_at FROM artifacts WHERE id = 'art-2'").get() as { removed_at: string | null };
    expect(row.removed_at).not.toBeNull(); // tombstoned, as before
  });

  it("doesn't touch artefacts whose path still exists on disk", async () => {
    writeFileSync(join(newDir, "ok.md"), "ok");
    seedFilesystemArtifact("art-3", join(newDir, "ok.md"));

    const result = await service.getAllArtifacts(() => {});

    expect(result.find((a) => a.id === "art-3")).toBeDefined();
    const row = db.prepare("SELECT storage_config, removed_at FROM artifacts WHERE id = 'art-3'").get() as { storage_config: string; removed_at: string | null };
    expect(row.removed_at).toBeNull();
    expect(JSON.parse(row.storage_config)).toEqual({ path: join(newDir, "ok.md") });
  });
});
