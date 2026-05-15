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
import { SpaceService, SourcePathConflictError } from "../src/space-service.js";
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

describe("SpaceService.removeSource — soft-delete + session detach", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it("nulls source_id on every session pointing at the source, mode untouched", () => {
    // Create a real directory so addSource doesn't reject.
    const folder = join(env.workDir, "proj");
    mkdirSync(folder);
    const space = env.service.createSpace({ name: "sp" });
    const source = env.service.addSource(space.id, folder);

    seedSession(env.db, { id: "auto", cwd: folder, source_id: source.id, space_id: space.id });
    seedSession(env.db, {
      id: "manual",
      cwd: folder,
      source_id: source.id,
      space_id: space.id,
      assignment_mode: "manual",
    });

    env.service.removeSource(source.id);

    expect(env.sessionStore.getById("auto")?.source_id).toBeNull();
    expect(env.sessionStore.getById("auto")?.assignment_mode).toBe("auto");
    expect(env.sessionStore.getById("manual")?.source_id).toBeNull();
    expect(env.sessionStore.getById("manual")?.assignment_mode).toBe("manual"); // still pinned, just orphan now
  });

  it("after detach + reattach, only auto sessions re-bind; manual stays orphan", () => {
    const folder = join(env.workDir, "proj");
    mkdirSync(folder);
    const space = env.service.createSpace({ name: "sp" });
    const first = env.service.addSource(space.id, folder);
    seedSession(env.db, { id: "auto", cwd: folder, source_id: first.id, space_id: space.id });
    seedSession(env.db, {
      id: "manual",
      cwd: folder,
      source_id: first.id,
      space_id: space.id,
      assignment_mode: "manual",
    });

    env.service.removeSource(first.id);
    // Reattach — addSource runs the heuristic.
    const restored = env.service.addSource(space.id, folder);

    expect(env.sessionStore.getById("auto")?.source_id).toBe(restored.id);
    expect(env.sessionStore.getById("manual")?.source_id).toBeNull(); // never recaptured by heuristic
  });
});

describe("SpaceService.addSource — orphan-tile attach with missing folder", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it("accepts a non-existent path and binds orphan auto-sessions whose cwd matches", () => {
    // Scenario from the field: 41 'done' sessions exist with cwd
    // ~/Dev/oyster-os, but that folder was renamed on disk. The orphan-tile
    // attach must succeed even though the path is gone, so the heuristic
    // can claim the sessions for the chosen space.
    const missing = join(env.workDir, "renamed-away");
    const space = env.service.createSpace({ name: "sp" });
    seedSession(env.db, { id: "a", cwd: missing });
    seedSession(env.db, { id: "b", cwd: join(missing, "sub") });

    const source = env.service.addSource(space.id, missing);
    expect(source.path).toBe(missing);
    expect(env.sessionStore.getById("a")?.source_id).toBe(source.id);
    expect(env.sessionStore.getById("b")?.source_id).toBe(source.id);

    // The tile would render with pathExists: false.
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

describe("SpaceService.updateSource", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it("rename to a sibling path: existing bindings stay; orphans with matching cwd re-bind", () => {
    const old = join(env.workDir, "old");
    const renamed = join(env.workDir, "renamed");
    mkdirSync(old);
    mkdirSync(renamed);
    const space = env.service.createSpace({ name: "sp" });
    const source = env.service.addSource(space.id, old);

    // One auto session is already bound to the source.
    seedSession(env.db, {
      id: "bound",
      cwd: join(old, "sub"),
      source_id: source.id,
      space_id: space.id,
    });
    // One orphan auto session whose cwd matches the NEW path (e.g. it was
    // run after the user mv'd the folder but before they updated Oyster).
    seedSession(env.db, { id: "orphan-new", cwd: join(renamed, "x") });
    // One manual orphan — should NOT be touched.
    seedSession(env.db, {
      id: "orphan-manual",
      cwd: join(renamed, "x"),
      assignment_mode: "manual",
    });

    env.service.updateSource(source.id, { path: renamed });

    expect(env.sessionStore.getById("bound")?.source_id).toBe(source.id);
    expect(env.sessionStore.getById("orphan-new")?.source_id).toBe(source.id);
    expect(env.sessionStore.getById("orphan-manual")?.source_id).toBeNull();
  });

  it("accepts a non-existent path (advisory existence)", () => {
    const folder = join(env.workDir, "exists");
    mkdirSync(folder);
    const space = env.service.createSpace({ name: "sp" });
    const source = env.service.addSource(space.id, folder);

    const missing = join(env.workDir, "not-mounted-yet");
    expect(() => env.service.updateSource(source.id, { path: missing })).not.toThrow();
  });

  it("rejects collision with another active source via SourcePathConflictError", () => {
    const a = join(env.workDir, "a");
    const b = join(env.workDir, "b");
    mkdirSync(a);
    mkdirSync(b);
    const space = env.service.createSpace({ name: "sp" });
    const srcA = env.service.addSource(space.id, a);
    const srcB = env.service.addSource(space.id, b);
    let caught: unknown;
    try { env.service.updateSource(srcA.id, { path: b }); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(SourcePathConflictError);
    const conflictErr = caught as SourcePathConflictError;
    expect(conflictErr.source.id).toBe(srcA.id);
    expect(conflictErr.conflict.id).toBe(srcB.id);
  });

  it("label-only update: doesn't run the rebind heuristic, leaves source_id untouched", () => {
    const folder = join(env.workDir, "p");
    mkdirSync(folder);
    const space = env.service.createSpace({ name: "sp" });
    const source = env.service.addSource(space.id, folder);

    // Orphan in the folder. Without an explicit path-update, label-only
    // mutation must NOT bind it.
    seedSession(env.db, { id: "orphan", cwd: folder });
    env.service.updateSource(source.id, { label: "Project A" });

    expect(env.sessionStore.getById("orphan")?.source_id).toBeNull();
    const sources = env.service.getSources(space.id);
    expect(sources.find((s) => s.id === source.id)?.label).toBe("Project A");
  });

  it("404s on unknown source", () => {
    expect(() => env.service.updateSource("nope", { path: "/whatever" })).toThrow(/not found/);
  });

  it("404s on detached (soft-deleted) source", () => {
    const folder = join(env.workDir, "p");
    mkdirSync(folder);
    const space = env.service.createSpace({ name: "sp" });
    const source = env.service.addSource(space.id, folder);
    env.service.removeSource(source.id);
    expect(() => env.service.updateSource(source.id, { label: "x" })).toThrow(/detached/);
  });
});

describe("SpaceService.consolidateSource — merge two sources in the same space", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it("moves sessions onto target, soft-deletes the source, preserves manual pin", () => {
    const a = join(env.workDir, "old");
    const b = join(env.workDir, "new");
    mkdirSync(a);
    mkdirSync(b);
    const space = env.service.createSpace({ name: "sp" });
    const srcA = env.service.addSource(space.id, a);
    const srcB = env.service.addSource(space.id, b);
    seedSession(env.db, { id: "auto", cwd: a, source_id: srcA.id, space_id: space.id });
    seedSession(env.db, {
      id: "manual",
      cwd: a,
      source_id: srcA.id,
      space_id: space.id,
      assignment_mode: "manual",
    });
    const result = env.service.consolidateSource(srcA.id, srcB.id);
    expect(result.sessionsMoved).toBe(2);
    expect(env.sessionStore.getById("auto")?.source_id).toBe(srcB.id);
    expect(env.sessionStore.getById("manual")?.source_id).toBe(srcB.id);
    expect(env.sessionStore.getById("manual")?.assignment_mode).toBe("manual"); // pin preserved
    // Source A is soft-deleted — getSources (active only) shouldn't include it.
    expect(env.service.getSources(space.id).map((s) => s.id)).toEqual([srcB.id]);
  });

  it("rejects merging a source into itself", () => {
    const a = join(env.workDir, "a");
    mkdirSync(a);
    const space = env.service.createSpace({ name: "sp" });
    const srcA = env.service.addSource(space.id, a);
    expect(() => env.service.consolidateSource(srcA.id, srcA.id)).toThrow(/itself/);
  });

  it("rejects cross-space consolidation", () => {
    const a = join(env.workDir, "a");
    const b = join(env.workDir, "b");
    mkdirSync(a);
    mkdirSync(b);
    const sp1 = env.service.createSpace({ name: "sp1" });
    const sp2 = env.service.createSpace({ name: "sp2" });
    const srcA = env.service.addSource(sp1.id, a);
    const srcB = env.service.addSource(sp2.id, b);
    expect(() => env.service.consolidateSource(srcA.id, srcB.id)).toThrow(/Cross-space/);
  });

  it("404s on unknown source ids", () => {
    expect(() => env.service.consolidateSource("nope-from", "nope-into")).toThrow(/not found/);
  });
});

describe("SpaceService.sourceContentSummary", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it("counts only live sessions + artefacts bound to the source", () => {
    const folder = join(env.workDir, "p");
    mkdirSync(folder);
    const space = env.service.createSpace({ name: "sp" });
    const source = env.service.addSource(space.id, folder);
    seedSession(env.db, { id: "s1", source_id: source.id, space_id: space.id });
    seedSession(env.db, { id: "s2", source_id: source.id, space_id: space.id });
    seedSession(env.db, { id: "s3", source_id: null, space_id: null }); // unrelated
    const summary = env.service.sourceContentSummary(source.id);
    expect(summary.sessionCount).toBe(2);
    expect(summary.artefactCount).toBe(0);
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
