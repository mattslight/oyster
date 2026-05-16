// Boot-time migration that undeletes artefacts whose file is recoverable
// via project_paths. Heals damage done by the old self-heal which
// soft-deleted every artefact whose folder happened to be renamed.
// Idempotent: a second boot finds no new tombstones to recover.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

const PROJ_ID = "11111111-2222-3333-4444-555555555555";

describe("initDb artefact tombstone recovery", () => {
  let userland: string;
  let oldDir: string;
  let newDir: string;

  beforeEach(() => {
    userland = mkdtempSync(join(tmpdir(), "oyster-atr-userland-"));
    oldDir = mkdtempSync(join(tmpdir(), "oyster-atr-old-"));
    newDir = mkdtempSync(join(tmpdir(), "oyster-atr-new-"));
  });
  afterEach(() => {
    rmSync(userland, { recursive: true, force: true });
    rmSync(oldDir, { recursive: true, force: true });
    rmSync(newDir, { recursive: true, force: true });
  });

  function seedTombstone(db: ReturnType<typeof initDb>, id: string, path: string) {
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none') ON CONFLICT(id) DO NOTHING`);
    db.prepare(`INSERT OR IGNORE INTO projects (id, space_id, name) VALUES (?, 'work', 'Proj')`).run(PROJ_ID);
    db.prepare(`INSERT OR IGNORE INTO project_paths (project_id, path) VALUES (?, ?)`).run(PROJ_ID, oldDir);
    db.prepare(`INSERT OR IGNORE INTO project_paths (project_id, path) VALUES (?, ?)`).run(PROJ_ID, newDir);
    db.prepare(
      `INSERT INTO artifacts (id, space_id, label, artifact_kind, storage_kind, storage_config, runtime_kind, runtime_config, removed_at)
       VALUES (?, 'work', 'doc', 'notes', 'filesystem', ?, 'static_file', '{}', datetime('now'))`,
    ).run(id, JSON.stringify({ path }));
  }

  it("undeletes a tombstoned artefact when the file is recoverable", () => {
    let db = initDb(userland);
    mkdirSync(join(newDir, "docs"), { recursive: true });
    writeFileSync(join(newDir, "docs", "report.md"), "ok");
    seedTombstone(db, "art-1", join(oldDir, "docs", "report.md"));
    db.close();

    // Re-open → migrations run → recovery fires.
    db = initDb(userland);
    const row = db.prepare("SELECT removed_at, storage_config, project_id FROM artifacts WHERE id = 'art-1'").get() as { removed_at: string | null; storage_config: string; project_id: string | null };
    expect(row.removed_at).toBeNull();
    expect(JSON.parse(row.storage_config)).toEqual({ path: join(newDir, "docs", "report.md") });
    expect(row.project_id).toBe(PROJ_ID);
    db.close();
  });

  it("leaves a tombstone alone when the file is not recoverable", () => {
    let db = initDb(userland);
    // newDir exists but doesn't contain the relative remainder
    seedTombstone(db, "art-2", join(oldDir, "docs", "gone.md"));
    db.close();

    db = initDb(userland);
    const row = db.prepare("SELECT removed_at FROM artifacts WHERE id = 'art-2'").get() as { removed_at: string | null };
    expect(row.removed_at).not.toBeNull(); // still tombstoned
    db.close();
  });

  it("idempotent — repeat boots don't re-flip already-recovered rows", () => {
    let db = initDb(userland);
    mkdirSync(join(newDir, "docs"), { recursive: true });
    writeFileSync(join(newDir, "docs", "x.md"), "ok");
    seedTombstone(db, "art-3", join(oldDir, "docs", "x.md"));
    db.close();

    // First boot: recovers
    db = initDb(userland);
    const firstUpdated = db.prepare("SELECT updated_at FROM artifacts WHERE id = 'art-3'").get() as { updated_at: string };
    db.close();

    // Second boot: row is alive, migration should NOT touch it
    db = initDb(userland);
    const secondUpdated = db.prepare("SELECT updated_at FROM artifacts WHERE id = 'art-3'").get() as { updated_at: string };
    expect(secondUpdated.updated_at).toBe(firstUpdated.updated_at);
    db.close();
  });
});
