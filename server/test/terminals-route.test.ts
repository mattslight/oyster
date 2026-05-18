// Unit tests for `resolveSourceCwd` — the heart of the source-typed
// launch contract. Cwd is never accepted from the client; the resolver
// turns a typed reference into a trusted cwd via the DB.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { ProjectService } from "../src/project-service.js";
import { resolveSourceCwd } from "../src/routes/terminals.js";

describe("resolveSourceCwd — project source", () => {
  let dir: string;
  let db: ReturnType<typeof initDb>;
  let sessionStore: SqliteSessionStore;
  let projectService: ProjectService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oyster-term-route-"));
    db = initDb(dir);
    sessionStore = new SqliteSessionStore(db);
    projectService = new ProjectService(db);
    // Seed a space so attachFolder succeeds.
    db.prepare(
      `INSERT INTO spaces (id, display_name, color, parent_id, scan_status)
       VALUES (?, ?, NULL, NULL, 'none')`,
    ).run("space-a", "Space A");
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves cwd from a live project path", () => {
    // Real folder on disk so existsSync passes.
    const livePath = mkdtempSync(join(tmpdir(), "oyster-term-proj-"));
    try {
      const { project } = projectService.attachFolder({ spaceId: "space-a", path: livePath });
      const result = resolveSourceCwd(
        { type: "project", id: project.id },
        {
          db,
          sessionStore,
          projectService,
          currentUserId: () => null,
        },
      );
      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.cwd).toBe(livePath);
      }
    } finally {
      rmSync(livePath, { recursive: true, force: true });
    }
  });

  it("returns project_not_found for unknown id", () => {
    const result = resolveSourceCwd(
      { type: "project", id: "does-not-exist" },
      { db, sessionStore, projectService, currentUserId: () => null },
    );
    expect(result).toEqual({ error: "project_not_found" });
  });

  it("returns project_homeless when the project has no live path", () => {
    // Attach a path that we then delete — project becomes homeless.
    const ephemeral = mkdtempSync(join(tmpdir(), "oyster-term-gone-"));
    const { project } = projectService.attachFolder({ spaceId: "space-a", path: ephemeral });
    rmSync(ephemeral, { recursive: true, force: true });

    const result = resolveSourceCwd(
      { type: "project", id: project.id },
      { db, sessionStore, projectService, currentUserId: () => null },
    );
    expect(result).toEqual({ error: "project_homeless" });
  });
});

describe("resolveSourceCwd — session source", () => {
  let dir: string;
  let db: ReturnType<typeof initDb>;
  let sessionStore: SqliteSessionStore;
  let projectService: ProjectService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oyster-term-route-"));
    db = initDb(dir);
    sessionStore = new SqliteSessionStore(db);
    projectService = new ProjectService(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves cwd from a local session row", () => {
    const liveCwd = mkdtempSync(join(tmpdir(), "oyster-term-sess-"));
    try {
      sessionStore.upsertSession({
        id: "s1",
        space_id: null,
        project_id: null,
        cwd: liveCwd,
        jsonl_path: null,
        agent: "claude-code",
        title: "test session",
        state: "active",
        started_at: new Date().toISOString(),
        model: null,
      });
      const result = resolveSourceCwd(
        { type: "session", id: "s1" },
        { db, sessionStore, projectService, currentUserId: () => null },
      );
      expect("error" in result).toBe(false);
      if (!("error" in result)) expect(result.cwd).toBe(liveCwd);
    } finally {
      rmSync(liveCwd, { recursive: true, force: true });
    }
  });

  it("returns session_not_found for unknown id", () => {
    const result = resolveSourceCwd(
      { type: "session", id: "nope" },
      { db, sessionStore, projectService, currentUserId: () => null },
    );
    expect(result).toEqual({ error: "session_not_found" });
  });

  it("returns session_no_cwd when the row has no cwd", () => {
    sessionStore.upsertSession({
      id: "s2",
      space_id: null,
      project_id: null,
      cwd: null,
      jsonl_path: null,
      agent: "claude-code",
      title: null,
      state: "active",
      started_at: new Date().toISOString(),
      model: null,
    });
    const result = resolveSourceCwd(
      { type: "session", id: "s2" },
      { db, sessionStore, projectService, currentUserId: () => null },
    );
    expect(result).toEqual({ error: "session_no_cwd" });
  });

  it("returns session_cwd_missing when the cwd doesn't exist", () => {
    sessionStore.upsertSession({
      id: "s3",
      space_id: null,
      project_id: null,
      cwd: "/this/path/does/not/exist/anywhere",
      jsonl_path: null,
      agent: "claude-code",
      title: null,
      state: "active",
      started_at: new Date().toISOString(),
      model: null,
    });
    const result = resolveSourceCwd(
      { type: "session", id: "s3" },
      { db, sessionStore, projectService, currentUserId: () => null },
    );
    expect(result).toEqual({ error: "session_cwd_missing" });
  });
});

describe("resolveSourceCwd — remote_session source", () => {
  let dir: string;
  let db: ReturnType<typeof initDb>;
  let sessionStore: SqliteSessionStore;
  let projectService: ProjectService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oyster-term-route-"));
    db = initDb(dir);
    sessionStore = new SqliteSessionStore(db);
    projectService = new ProjectService(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns session_not_reassembled_yet when no user signed in", () => {
    const result = resolveSourceCwd(
      { type: "remote_session", id: "rs1" },
      { db, sessionStore, projectService, currentUserId: () => null },
    );
    expect(result).toEqual({ error: "session_not_reassembled_yet" });
  });

  it("returns cwd_not_on_this_device when the jsonl has no cwd matching the encoded dir", () => {
    // Mimic the on-disk shape `<root>/<encodedCwd>/<id>.jsonl`. The first
    // line's `cwd` field doesn't encode to the parent dir, so pickJsonlCwd
    // returns null and we get cwd_not_on_this_device.
    const projectsRoot = join(dir, "projects");
    const encoded = "-fake-encoded";
    const sessDir = join(projectsRoot, encoded);
    mkdirSync(sessDir, { recursive: true });
    const jsonlPath = join(sessDir, "rs2.jsonl");
    writeFileSync(jsonlPath, JSON.stringify({ cwd: "/some/other/path", type: "system" }) + "\n");

    const now = Date.now();
    db.prepare(
      `INSERT INTO remote_sessions (owner_id, session_id, agent, state, has_bytes, jsonl_local_path,
                                    started_at, last_event_at, cloud_updated_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "user-1", "rs2", "claude-code", "done", 1, jsonlPath,
      new Date().toISOString(), new Date().toISOString(), now, now,
    );

    const result = resolveSourceCwd(
      { type: "remote_session", id: "rs2" },
      { db, sessionStore, projectService, currentUserId: () => "user-1" },
    );
    expect(result).toEqual({ error: "cwd_not_on_this_device" });
  });
});
