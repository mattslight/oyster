import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { tryHandleSessionRoute } from "../src/routes/sessions.js";
import { LocalDivergedError } from "../src/session-sync-service.js";

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
// star; device_identity is read for the active-device chip.
function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE remote_sessions (
      session_id TEXT NOT NULL, owner_id TEXT NOT NULL, device_id TEXT,
      device_label TEXT,
      agent TEXT NOT NULL, title TEXT, state TEXT NOT NULL, cwd TEXT,
      model TEXT, started_at TEXT NOT NULL, ended_at TEXT,
      last_event_at TEXT NOT NULL, bytes_generation INTEGER NOT NULL DEFAULT 0,
      has_bytes INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER,
      active_device_id TEXT,
      cloud_updated_at INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL, jsonl_local_path TEXT,
      PRIMARY KEY (owner_id, session_id)
    );
    CREATE TABLE device_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      device_id TEXT NOT NULL,
      label TEXT NOT NULL
    );
  `);
  return db;
}

function insertRemote(
  db: Database.Database,
  opts: {
    sessionId: string;
    ownerId: string;
    cwd: string | null;
    hasBytes: boolean;
    deviceId?: string;
    /** Override title (default 't') — pass null to test the ghost-session filter. */
    title?: string | null;
    /** Override ended_at (default null) — set to test "ended cleanly" exemption. */
    endedAt?: string | null;
    /** Override total_bytes — drives the ghost-session filter. */
    totalBytes?: number | null;
    /** Override active_device_id — drives the active-writer chip. */
    activeDeviceId?: string | null;
  },
) {
  db.prepare(
    `INSERT INTO remote_sessions
       (session_id, owner_id, device_id, agent, title, state, cwd, model,
        started_at, ended_at, last_event_at, bytes_generation, has_bytes, total_bytes,
        active_device_id, cloud_updated_at, fetched_at, jsonl_local_path)
     VALUES (?, ?, ?, 'claude-code', ?, 'done', ?, 'm',
             '2026-05-11T10:00:00Z', ?, '2026-05-11T10:30:00Z',
             0, ?, ?, ?, 1000, ?, NULL)`,
  ).run(
    opts.sessionId, opts.ownerId, opts.deviceId ?? "dev-pc",
    opts.title === undefined ? "t" : opts.title,
    opts.cwd,
    opts.endedAt === undefined ? null : opts.endedAt,
    opts.hasBytes ? 1 : 0,
    opts.totalBytes === undefined ? null : opts.totalBytes,
    opts.activeDeviceId === undefined ? null : opts.activeDeviceId,
    Date.now(),
  );
}

function stubSessionSync(behaviour: "success" | "throw" | "diverged" = "success") {
  return {
    reassembleSessionJsonl: vi.fn(async (sessionId: string, targetPath: string) => {
      if (behaviour === "throw") throw new Error("simulated reassembly failure");
      if (behaviour === "diverged") {
        throw new LocalDivergedError("local jsonl is 99 bytes but cloud chain is 42");
      }
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

  it("happy path: targetCwd + force:true, calls reassemble, returns command", async () => {
    // Post sources→projects: the client always supplies targetCwd; the
    // server no longer guesses via local sources. force:true bypasses the
    // not_a_git_repo warning on the throwaway dir.
    const localProj = mkdtempSync(join(tmpdir(), "oyster-route-happy-"));
    insertRemote(db, { sessionId: "abc-123", ownerId: "user-A", cwd: "/orig/auto-resolve-proj", hasBytes: true });

    const sync = stubSessionSync("success");
    const { ctx, captured } = fakeCtx({ targetCwd: localProj, force: true });
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
    // targetCwd + force:true bypasses validation so we reach the
    // reassemble call (which the stub throws from).
    const realDir = mkdtempSync(join(tmpdir(), "oyster-route-throws-"));
    insertRemote(db, { sessionId: "abc-123", ownerId: "user-A", cwd: realDir, hasBytes: true });
    const sync = stubSessionSync("throw");
    const { ctx, captured } = fakeCtx({ targetCwd: realDir, force: true });
    const req = { method: "POST" } as any;
    await tryHandleSessionRoute(req, {} as any, "/api/sessions/abc-123/resume",
      ctx as any, baseDeps(db, { ownerId: "user-A", sessionSync: sync }));
    expect(captured.status).toBe(500);
    expect(captured.json).toMatchObject({
      error: "reassemble_failed",
      message: "simulated reassembly failure",
    });
  });

  it("409 local_diverged when the service throws LocalDivergedError", async () => {
    // Same shape as the generic 500 test, but the stub throws the dedicated
    // class so the route branches into the structured response shape rather
    // than the catch-all 500. Verifies instanceof-based dispatch.
    const realDir = mkdtempSync(join(tmpdir(), "oyster-route-diverged-"));
    insertRemote(db, { sessionId: "div-1", ownerId: "user-A", cwd: realDir, hasBytes: true });
    const sync = stubSessionSync("diverged");
    const { ctx, captured } = fakeCtx({ targetCwd: realDir, force: true });
    const req = { method: "POST" } as any;
    await tryHandleSessionRoute(req, {} as any, "/api/sessions/div-1/resume",
      ctx as any, baseDeps(db, { ownerId: "user-A", sessionSync: sync }));
    expect(captured.status).toBe(409);
    expect(captured.json).toMatchObject({
      status: "local_diverged",
      message: expect.stringContaining("local jsonl is 99 bytes"),
    });
    expect((captured.json as { localJsonlPath: string }).localJsonlPath).toMatch(/div-1\.jsonl$/);
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

  it("hides ghost remote sessions (title null + ended_at null + tiny byte count)", async () => {
    // The dogfood `matth (no title yet)` rows: aborted `claude` invocations
    // that left only permission/file-history/exit events in the jsonl. Hide
    // them so Home doesn't fill up with non-content.
    const db = makeDb();
    insertRemote(db, {
      sessionId: "ghost-1", ownerId: "user-A", cwd: "C:\\Users\\matth",
      hasBytes: true, title: null, endedAt: null, totalBytes: 1853,
    });
    insertRemote(db, {
      sessionId: "real-titled", ownerId: "user-A", cwd: "C:\\proj",
      hasBytes: true, title: "real conversation", endedAt: null, totalBytes: 1500,
    });
    insertRemote(db, {
      sessionId: "ended-untitled", ownerId: "user-A", cwd: "C:\\proj",
      hasBytes: true, title: null, endedAt: "2026-05-10T12:00:00Z", totalBytes: 100,
    });
    insertRemote(db, {
      sessionId: "big-untitled", ownerId: "user-A", cwd: "C:\\proj",
      hasBytes: true, title: null, endedAt: null, totalBytes: 50_000,
    });
    insertRemote(db, {
      sessionId: "legacy-no-bytecount", ownerId: "user-A", cwd: "C:\\proj",
      hasBytes: true, title: null, endedAt: null, totalBytes: null,
    });
    const sessionStore = { getAll: () => [] } as any;
    const { ctx, captured } = fakeCtx();
    const req = { method: "GET" } as any;
    await tryHandleSessionRoute(req, {} as any, "/api/sessions",
      ctx as any, {
        db, sessionStore, spaceStore: { getSourcesByIds: () => [] } as any,
        artifactService: {} as any, memoryProvider: {} as any,
        sessionSync: stubSessionSync(),
        currentUserId: () => "user-A",
      });
    const ids = (captured.json as Array<{ id: string }>).map((s) => s.id).sort();
    // ghost-1 hidden; everything else surfaced for one reason or another.
    expect(ids).toEqual(["big-untitled", "ended-untitled", "legacy-no-bytecount", "real-titled"]);
  });

  it("computes activeDeviceLabel from local device_identity and origin", async () => {
    // Three scenarios in one go:
    //   - active is us → resolves to our local device_identity.label
    //   - active equals origin → resolves to remote_sessions.device_label
    //   - active is a third unknown device → null (we don't make one up)
    const db = makeDb();
    db.prepare(`INSERT INTO device_identity (id, device_id, label) VALUES (1, 'dev-mac', 'MacBookPro')`).run();

    // Origin Windows, active = Mac (us). UI should render "Now active here".
    insertRemote(db, {
      sessionId: "s-handed-to-me", ownerId: "user-A", cwd: "C:\\proj",
      hasBytes: true, deviceId: "dev-windows", activeDeviceId: "dev-mac",
    });
    db.prepare(`UPDATE remote_sessions SET device_label = 'WIN-DESKTOP' WHERE session_id = 's-handed-to-me'`).run();

    // Origin Windows, active = Windows (steady state). resolveActiveLabel
    // returns origin's label, but the UI helper hides this case (no handoff).
    insertRemote(db, {
      sessionId: "s-still-on-origin", ownerId: "user-A", cwd: "C:\\proj",
      hasBytes: true, deviceId: "dev-windows", activeDeviceId: "dev-windows",
    });
    db.prepare(`UPDATE remote_sessions SET device_label = 'WIN-DESKTOP' WHERE session_id = 's-still-on-origin'`).run();

    // Origin Windows, active = third Linux device we've never seen.
    insertRemote(db, {
      sessionId: "s-unknown-active", ownerId: "user-A", cwd: "C:\\proj",
      hasBytes: true, deviceId: "dev-windows", activeDeviceId: "dev-linux",
    });

    const { ctx, captured } = fakeCtx();
    const req = { method: "GET" } as any;
    await tryHandleSessionRoute(req, {} as any, "/api/sessions",
      ctx as any, {
        db, sessionStore: { getAll: () => [] } as any,
        spaceStore: { getSourcesByIds: () => [] } as any,
        artifactService: {} as any, memoryProvider: {} as any,
        sessionSync: stubSessionSync(),
        currentUserId: () => "user-A",
      });
    const byId = new Map(
      (captured.json as Array<{ id: string; activeDeviceLabel: string | null }>).map((s) => [s.id, s.activeDeviceLabel]),
    );
    expect(byId.get("s-handed-to-me")).toBe("MacBookPro");
    expect(byId.get("s-still-on-origin")).toBe("WIN-DESKTOP");
    expect(byId.get("s-unknown-active")).toBeNull();
  });
});

describe("GET /api/sessions/:id falls back to remote_sessions", () => {
  // Regression: PR 3.1 surfaced cross-device sessions in the list view, but
  // the singular GET only checked local sessions. Clicking a remote session
  // returned 404 → the inspector closed with "Session no longer available".
  it("returns a remote row when no local session matches the id", async () => {
    const db = makeDb();
    insertRemote(db, {
      sessionId: "remote-only-1",
      ownerId: "user-A",
      cwd: "C:\\Users\\matth",
      hasBytes: true,
      deviceId: "dev-pc",
    });
    // Set device_label to verify it flows back through the route.
    db.prepare(
      `UPDATE remote_sessions SET device_label = 'WIN-DESKTOP' WHERE session_id = 'remote-only-1'`,
    ).run();
    const sessionStore = { getById: () => undefined } as any;
    const spaceStore = { getSourceById: () => undefined } as any;
    const { ctx, captured } = fakeCtx();
    const req = { method: "GET" } as any;
    const handled = await tryHandleSessionRoute(req, {} as any, "/api/sessions/remote-only-1",
      ctx as any, {
        db, sessionStore, spaceStore,
        artifactService: {} as any, memoryProvider: {} as any,
        sessionSync: stubSessionSync(),
        currentUserId: () => "user-A",
      });
    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.json).toMatchObject({
      id: "remote-only-1",
      originDeviceId: "dev-pc",
      originDeviceLabel: "WIN-DESKTOP",
      hasBytes: true,
      jsonlAvailableLocally: false,
    });
  });

  it("still 404s when the id is in neither table", async () => {
    const db = makeDb();
    const sessionStore = { getById: () => undefined } as any;
    const spaceStore = { getSourceById: () => undefined } as any;
    const { ctx, captured } = fakeCtx();
    const req = { method: "GET" } as any;
    // Need a fake res that captures status — the route writes 404 directly
    // via res.writeHead/end rather than ctx.sendJson, so add a minimal stub.
    const res = {
      writeHead: (s: number) => { captured.status = s; return res; },
      end: (body: string) => { captured.json = JSON.parse(body); },
    } as any;
    await tryHandleSessionRoute(req, res, "/api/sessions/unknown-id",
      ctx as any, {
        db, sessionStore, spaceStore,
        artifactService: {} as any, memoryProvider: {} as any,
        sessionSync: stubSessionSync(),
        currentUserId: () => "user-A",
      });
    expect(captured.status).toBe(404);
    expect(captured.json).toEqual({ error: "session not found" });
  });

  it("returns a local row when one exists (preferred over remote)", async () => {
    const db = makeDb();
    insertRemote(db, {
      sessionId: "dup-id",
      ownerId: "user-A",
      cwd: "C:\\elsewhere",
      hasBytes: true,
      deviceId: "dev-pc",
    });
    const localRow = {
      id: "dup-id", space_id: "space-1", source_id: null, cwd: "/Users/me/local",
      agent: "claude-code", title: "local title", state: "active",
      started_at: "2026-05-11T09:00:00Z", ended_at: null, model: "m",
      last_event_at: "2026-05-11T09:30:00Z",
    };
    const sessionStore = { getById: (id: string) => id === "dup-id" ? localRow : undefined } as any;
    const spaceStore = { getSourceById: () => undefined } as any;
    const { ctx, captured } = fakeCtx();
    const req = { method: "GET" } as any;
    await tryHandleSessionRoute(req, {} as any, "/api/sessions/dup-id",
      ctx as any, {
        db, sessionStore, spaceStore,
        artifactService: {} as any, memoryProvider: {} as any,
        sessionSync: stubSessionSync(),
        currentUserId: () => "user-A",
      });
    expect(captured.status).toBe(200);
    expect(captured.json).toMatchObject({
      id: "dup-id",
      title: "local title",
      // Local row → null/true; not the cross-device shape.
      originDeviceId: null,
      jsonlAvailableLocally: true,
    });
  });
});

// Touch `existsSync` so the import isn't flagged as unused on linter passes
// that don't see it via downstream calls. The test sometimes needs to assert
// on file absence separately.
void existsSync;
void writeFileSync;
