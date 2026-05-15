// SpaceService — detach correctness + updateSource + pathExists.
// Phase B integration: exercises the transaction-coordinated mutations
// that REST and MCP both call through.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { SqliteSpaceStore } from "../src/space-store.js";
import { SpaceService } from "../src/space-service.js";
import { SqliteArtifactStore } from "../src/artifact-store.js";
import { ArtifactService } from "../src/artifact-service.js";
import type Database from "better-sqlite3";

function seedSession(
  db: Database.Database,
  fields: {
    id: string;
    cwd?: string | null;
    source_id?: string | null;
    space_id?: string | null;
    assignment_mode?: "auto" | "manual";
  },
) {
  db.prepare(
    `INSERT INTO sessions
       (id, space_id, source_id, cwd, agent, title, state,
        started_at, last_event_at, assignment_mode)
     VALUES (?, ?, ?, ?, 'claude-code', 't', 'done',
             '2026-05-15T10:00:00Z', '2026-05-15T10:30:00Z', ?)`,
  ).run(
    fields.id,
    fields.space_id ?? null,
    fields.source_id ?? null,
    fields.cwd ?? null,
    fields.assignment_mode ?? "auto",
  );
}

function makeEnv() {
  // Canonicalise the tmp dir so test session cwds match the source paths
  // that go through normaliseSourcePath. macOS tmpdir() returns a symlinked
  // `/var/...` path; real claude-code cwds (from process.cwd()) are
  // already canonical, so the mismatch only surfaces in tests.
  const workDir = realpathSync(mkdtempSync(join(tmpdir(), "oyster-svc-binding-")));
  const db = initDb(workDir);
  const spaceStore = new SqliteSpaceStore(db);
  const sessionStore = new SqliteSessionStore(db);
  const artifactStore = new SqliteArtifactStore(db);
  const artifactService = new ArtifactService(
    artifactStore,
    { spacesDir: join(workDir, "spaces"), appsDir: join(workDir, "apps") } as any,
    { broadcast: () => {} } as any,
  );
  const service = new SpaceService(spaceStore, artifactStore, artifactService, sessionStore);
  return {
    workDir, db, spaceStore, sessionStore, service,
    cleanup: () => { db.close(); rmSync(workDir, { recursive: true, force: true }); },
  };
}

// Removed: removeSource / updateSource / consolidateSource / sourceContentSummary
// describes — the methods themselves were deleted as part of the projects
// rewrite. project-service.test.ts covers the replacements (deleteProject,
// claim_orphan, etc.). The two describes that remain test addSource (still
// alive: createSpaceFromPath + onboard_space MCP tool call it) and
// getSources (read-only).

describe("SpaceService.addSource — orphan-tile attach with missing folder", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it("accepts a non-existent path (advisory existence)", () => {
    // Scenario from the field: sessions exist with cwd ~/Dev/oyster-os, but
    // that folder was renamed on disk. The attach must still succeed; the
    // tile renders with pathExists: false. (Auto-rebind was removed; orphan
    // recovery now goes through claim_orphan in project-service.)
    const missing = join(env.workDir, "renamed-away");
    const space = env.service.createSpace({ name: "sp" });

    const source = env.service.addSource(space.id, missing);
    expect(source.path).toBe(missing);
    const sources = env.service.getSources(space.id);
    expect(sources.find((s) => s.id === source.id)?.pathExists).toBe(false);
  });

  it("still rejects a path that exists but is a file rather than a directory", () => {
    const filePath = join(env.workDir, "not-a-dir");
    writeFileSync(filePath, "hi");
    const space = env.service.createSpace({ name: "sp" });
    expect(() => env.service.addSource(space.id, filePath)).toThrow(/not a directory/);
  });
});

describe("SpaceService.getSources — pathExists", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it("reports pathExists: true for a present folder, false for a missing one", () => {
    const present = join(env.workDir, "here");
    mkdirSync(present);
    const space = env.service.createSpace({ name: "sp" });
    const src1 = env.service.addSource(space.id, present);

    // Make a second source point at a non-existent path (via updateSource,
    // since addSource takes the path through normaliseSourcePath at attach
    // time; we then delete the folder to simulate an unmounted drive or
    // rename. This is the "user
    // renamed the folder on disk before telling Oyster" / unmounted-drive
    // scenario.
    const missing = join(env.workDir, "gone");
    mkdirSync(missing);
    const src2 = env.service.addSource(space.id, missing);
    rmSync(missing, { recursive: true });

    const sources = env.service.getSources(space.id);
    const a = sources.find((s) => s.id === src1.id);
    const b = sources.find((s) => s.id === src2.id);
    expect(a?.pathExists).toBe(true);
    expect(b?.pathExists).toBe(false);
  });
});
