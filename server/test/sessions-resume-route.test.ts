import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { tryHandleSessionRoute } from "../src/routes/sessions.js";

// Fake req/res/ctx mirrors the shape in pin-route.test.ts.
function fakeCtx(body: unknown = {}) {
  const captured: { status?: number; json?: unknown } = {};
  const ctx = {
    sendJson: (j: unknown, s = 200) => { captured.json = j; captured.status = s; },
    sendError: (err: unknown, s = 500) => {
      captured.json = { error: err instanceof Error ? err.message : String(err) };
      captured.status = s;
    },
    rejectIfNonLocalOrigin: () => false,
    readJsonBody: async () => body as Record<string, unknown>,
  };
  return { ctx, captured };
}

// Build the minimum schema the route reads from. remote_sessions is the
// star; sources is needed for candidate resolution; sessions is needed by
// the existing GET /api/sessions logic (irrelevant for resume but the
// shared route handler touches it).
function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE remote_sessions (
      session_id TEXT NOT NULL, owner_id TEXT NOT NULL, device_id TEXT,
      agent TEXT NOT NULL, title TEXT, state TEXT NOT NULL, cwd TEXT,
      model TEXT, started_at TEXT NOT NULL, ended_at TEXT,
      last_event_at TEXT NOT NULL, bytes_generation INTEGER NOT NULL DEFAULT 0,
      has_bytes INTEGER NOT NULL DEFAULT 0, cloud_updated_at INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL, jsonl_local_path TEXT,
      PRIMARY KEY (owner_id, session_id)
    );
    CREATE TABLE sources (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, type TEXT NOT NULL,
      path TEXT NOT NULL, label TEXT,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      removed_at TEXT
    );
  `);
  return db;
}

function insertRemote(
  db: Database.Database,
  opts: { sessionId: string; ownerId: string; cwd: string | null; hasBytes: boolean; deviceId?: string },
) {
  db.prepare(
    `INSERT INTO remote_sessions
       (session_id, owner_id, device_id, agent, title, state, cwd, model,
        started_at, ended_at, last_event_at, bytes_generation, has_bytes,
        cloud_updated_at, fetched_at, jsonl_local_path)
     VALUES (?, ?, ?, 'claude-code', 't', 'done', ?, 'm',
             '2026-05-11T10:00:00Z', NULL, '2026-05-11T10:30:00Z',
             0, ?, 1000, ?, NULL)`,
  ).run(opts.sessionId, opts.ownerId, opts.deviceId ?? "dev-pc", opts.cwd, opts.hasBytes ? 1 : 0, Date.now());
}

function insertSource(db: Database.Database, id: string, path: string, spaceId = "space-1") {
  db.prepare(
    `INSERT INTO sources (id, space_id, type, path, label) VALUES (?, ?, 'local_folder', ?, NULL)`,
  ).run(id, spaceId, path);
}

function stubSessionSync(behaviour: "success" | "throw" = "success") {
  return {
    reassembleSessionJsonl: vi.fn(async (sessionId: string, targetPath: string) => {
      if (behaviour === "throw") throw new Error("simulated reassembly failure");
      return { chunkCount: 1, totalBytes: 42, generation: 0, targetPath };
    }),
    // Unused but interface requires them.
    reconcile: vi.fn(),
    pushPending: vi.fn(),
    pull: vi.fn(),
    pushBytes: vi.fn(),
    markDirty: vi.fn(),
  };
}

const baseDeps = (db: Database.Database, opts: {
  ownerId?: string | null;
  sessionSync?: ReturnType<typeof stubSessionSync>;
}) => ({
  db,
  sessionStore: { getAll: () => [] } as any,
  spaceStore: { getSourcesByIds: () => [] } as any,
  artifactService: {} as any,
  memoryProvider: {} as any,
  sessionSync: opts.sessionSync ?? stubSessionSync(),
  currentUserId: () => opts.ownerId ?? null,
});

describe("POST /api/sessions/:id/resume", () => {
  let db: Database.Database;
  let projectsRootDir: string;

  beforeEach(() => {
    db = makeDb();
    projectsRootDir = mkdtempSync(join(tmpdir(), "oyster-resume-route-"));
    process.env.OYSTER_CLAUDE_PROJECTS_ROOT = projectsRootDir;
  });

  it("401 sign_in_required when no Pro user", async () => {
    insertRemote(db, { sessionId: "s1", ownerId: "user-A", cwd: "/tmp/x", hasBytes: true });
    const { ctx, captured } = fakeCtx({});
    const req = { method: "POST" } as any;
    const handled = await tryHandleSessionRoute(req, {} as any, "/api/sessions/s1/resume",
      ctx as any, baseDeps(db, { ownerId: null }));
    expect(handled).toBe(true);
    expect(captured.status).toBe(401);
    expect(captured.json).toEqual({ error: "sign_in_required" });
  });

  it("404 when session not in remote_sessions", async () => {
    const { ctx, captured } = fakeCtx({});
    const req = { method: "POST" } as any;
    const handled = await tryHandleSessionRoute(req, {} as any, "/api/sessions/unknown/resume",
      ctx as any, baseDeps(db, { ownerId: "user-A" }));
    expect(handled).toBe(true);
    expect(captured.status).toBe(404);
    expect(captured.json).toMatchObject({ error: "session_not_found_in_remote" });
  });

  it("409 bytes_not_available when has_bytes = 0", async () => {
    insertRemote(db, { sessionId: "s1", ownerId: "user-A", cwd: "/tmp/x", hasBytes: false });
    const { ctx, captured } = fakeCtx({});
    const req = { method: "POST" } as any;
    const handled = await tryHandleSessionRoute(req, {} as any, "/api/sessions/s1/resume",
      ctx as any, baseDeps(db, { ownerId: "user-A" }));
    expect(handled).toBe(true);
    expect(captured.status).toBe(409);
    expect(captured.json).toMatchObject({ error: "bytes_not_available" });
  });

  it("needs_target when no local source matches the remote cwd", async () => {
    insertRemote(db, { sessionId: "s1", ownerId: "user-A", cwd: "/Users/somebody-else/proj", hasBytes: true });
    const { ctx, captured } = fakeCtx({});
    const req = { method: "POST" } as any;
    await tryHandleSessionRoute(req, {} as any, "/api/sessions/s1/resume",
      ctx as any, baseDeps(db, { ownerId: "user-A" }));
    expect(captured.status).toBe(200);
    expect(captured.json).toMatchObject({
      status: "needs_target",
      remoteCwd: "/Users/somebody-else/proj",
    });
  });

  it("pick_source when multiple sources match", async () => {
    insertRemote(db, { sessionId: "s1", ownerId: "user-A", cwd: "/orig/proj", hasBytes: true });
    insertSource(db, "src-1", "/local/a/proj");
    insertSource(db, "src-2", "/local/b/proj");
    const { ctx, captured } = fakeCtx({});
    const req = { method: "POST" } as any;
    await tryHandleSessionRoute(req, {} as any, "/api/sessions/s1/resume",
      ctx as any, baseDeps(db, { ownerId: "user-A" }));
    expect(captured.status).toBe(200);
    expect(captured.json).toMatchObject({ status: "pick_source" });
    const body = captured.json as { status: string; candidates: Array<{ path: string }> };
    expect(body.candidates.map((c) => c.path).sort()).toEqual(["/local/a/proj", "/local/b/proj"]);
  });

  it("happy path: auto-resolve via single matching source, calls reassemble, returns command", async () => {
    // Set up: source whose basename matches the remote cwd's basename.
    const localProj = join(projectsRootDir, "..", "auto-resolve-proj");
    mkdirSync(localProj, { recursive: true });
    // Remote cwd ends in "auto-resolve-proj" too → basename match wins.
    insertRemote(db, { sessionId: "abc-123", ownerId: "user-A", cwd: "/orig/auto-resolve-proj", hasBytes: true });
    insertSource(db, "src-1", localProj);

    const sync = stubSessionSync("success");
    const { ctx, captured } = fakeCtx({});
    const req = { method: "POST" } as any;
    await tryHandleSessionRoute(req, {} as any, "/api/sessions/abc-123/resume",
      ctx as any, baseDeps(db, { ownerId: "user-A", sessionSync: sync }));

    expect(captured.status).toBe(200);
    expect(captured.json).toMatchObject({
      status: "ok",
      sessionId: "abc-123",
      localCwd: localProj,
    });
    expect(sync.reassembleSessionJsonl).toHaveBeenCalledOnce();
    const command = (captured.json as { command: string }).command;
    expect(command).toContain("claude --resume abc-123");
    expect(command).toContain(localProj);
  });

  it("validation_warning when targetCwd is missing on disk", async () => {
    insertRemote(db, { sessionId: "s1", ownerId: "user-A", cwd: "/orig/proj", hasBytes: true });
    const { ctx, captured } = fakeCtx({ targetCwd: "/no/such/folder" });
    const req = { method: "POST" } as any;
    await tryHandleSessionRoute(req, {} as any, "/api/sessions/s1/resume",
      ctx as any, baseDeps(db, { ownerId: "user-A" }));
    expect(captured.status).toBe(200);
    expect(captured.json).toMatchObject({
      status: "validation_warning",
      reasons: ["target_folder_missing"],
    });
  });

  it("validation_warning surfaces non-fatal reasons when targetCwd is not a git repo (without force)", async () => {
    const realDir = mkdtempSync(join(tmpdir(), "oyster-route-nonrepo-"));
    // realDir exists, basename is unlikely to match, no .git → multiple warnings
    insertRemote(db, { sessionId: "s1", ownerId: "user-A", cwd: "/orig/proj-different", hasBytes: true });
    const { ctx, captured } = fakeCtx({ targetCwd: realDir });
    const req = { method: "POST" } as any;
    await tryHandleSessionRoute(req, {} as any, "/api/sessions/s1/resume",
      ctx as any, baseDeps(db, { ownerId: "user-A" }));
    expect(captured.status).toBe(200);
    expect(captured.json).toMatchObject({ status: "validation_warning" });
    const reasons = (captured.json as { reasons: string[] }).reasons;
    expect(reasons).toContain("not_a_git_repo");
  });

  it("force:true bypasses validation_warning and proceeds with reassembly", async () => {
    const realDir = mkdtempSync(join(tmpdir(), "oyster-route-force-"));
    insertRemote(db, { sessionId: "abc-123", ownerId: "user-A", cwd: "/orig/proj", hasBytes: true });
    const sync = stubSessionSync("success");
    const { ctx, captured } = fakeCtx({ targetCwd: realDir, force: true });
    const req = { method: "POST" } as any;
    await tryHandleSessionRoute(req, {} as any, "/api/sessions/abc-123/resume",
      ctx as any, baseDeps(db, { ownerId: "user-A", sessionSync: sync }));
    expect(captured.status).toBe(200);
    expect(captured.json).toMatchObject({ status: "ok", localCwd: realDir });
    expect(sync.reassembleSessionJsonl).toHaveBeenCalledOnce();
  });

  it("500 reassemble_failed when the service throws", async () => {
    // Use auto-resolve with a single matching source so we get past validation
    // to the actual reassemble call.
    const realDir = mkdtempSync(join(tmpdir(), "oyster-route-throws-"));
    insertRemote(db, { sessionId: "abc-123", ownerId: "user-A", cwd: realDir, hasBytes: true });
    insertSource(db, "src-1", realDir);
    const sync = stubSessionSync("throw");
    const { ctx, captured } = fakeCtx({});
    const req = { method: "POST" } as any;
    await tryHandleSessionRoute(req, {} as any, "/api/sessions/abc-123/resume",
      ctx as any, baseDeps(db, { ownerId: "user-A", sessionSync: sync }));
    expect(captured.status).toBe(500);
    expect(captured.json).toMatchObject({
      error: "reassemble_failed",
      message: "simulated reassembly failure",
    });
  });
});

describe("GET /api/sessions merges local + remote", () => {
  it("returns merged list with originDeviceId + jsonlAvailableLocally", async () => {
    const db = makeDb();
    insertRemote(db, { sessionId: "remote-1", ownerId: "user-A", cwd: "/orig/proj", hasBytes: true, deviceId: "dev-pc" });
    const sessionStore = {
      getAll: () => [{
        id: "local-1", space_id: "space-1", source_id: null, cwd: "/Users/me/local",
        agent: "claude-code", title: "local", state: "done",
        started_at: "2026-05-11T09:00:00Z", ended_at: null, model: "m",
        last_event_at: "2026-05-11T09:30:00Z",
      }],
    } as any;
    const spaceStore = { getSourcesByIds: () => [] } as any;
    const { ctx, captured } = fakeCtx();
    const req = { method: "GET" } as any;
    await tryHandleSessionRoute(req, {} as any, "/api/sessions",
      ctx as any, {
        db, sessionStore, spaceStore,
        artifactService: {} as any, memoryProvider: {} as any,
        sessionSync: stubSessionSync(),
        currentUserId: () => "user-A",
      });

    const list = captured.json as Array<{ id: string; originDeviceId: string | null; jsonlAvailableLocally: boolean }>;
    expect(list.length).toBe(2);
    const local = list.find((s) => s.id === "local-1");
    const remote = list.find((s) => s.id === "remote-1");
    expect(local?.originDeviceId).toBeNull();
    expect(local?.jsonlAvailableLocally).toBe(true);
    expect(remote?.originDeviceId).toBe("dev-pc");
    expect(remote?.jsonlAvailableLocally).toBe(false);  // jsonl_local_path is NULL
  });

  it("filters remote rows whose session_id collides with a local session", async () => {
    const db = makeDb();
    // Same session_id exists in both local and remote — local wins.
    insertRemote(db, { sessionId: "dup", ownerId: "user-A", cwd: "/orig/proj", hasBytes: true, deviceId: "dev-pc" });
    const sessionStore = {
      getAll: () => [{
        id: "dup", space_id: null, source_id: null, cwd: "/Users/me/local",
        agent: "claude-code", title: "local-version", state: "done",
        started_at: "2026-05-11T09:00:00Z", ended_at: null, model: "m",
        last_event_at: "2026-05-11T09:30:00Z",
      }],
    } as any;
    const { ctx, captured } = fakeCtx();
    const req = { method: "GET" } as any;
    await tryHandleSessionRoute(req, {} as any, "/api/sessions",
      ctx as any, {
        db, sessionStore, spaceStore: { getSourcesByIds: () => [] } as any,
        artifactService: {} as any, memoryProvider: {} as any,
        sessionSync: stubSessionSync(),
        currentUserId: () => "user-A",
      });
    const list = captured.json as Array<{ id: string; title: string; originDeviceId: string | null }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe("local-version");
    expect(list[0]!.originDeviceId).toBeNull();
  });
});

// Touch `existsSync` so the import isn't flagged as unused on linter passes
// that don't see it via downstream calls. The test sometimes needs to assert
// on file absence separately.
void existsSync;
void writeFileSync;
