// Tests for the ghost-session cleanup logic introduced to fix the regression
// where stub session rows inserted at spawn time survive as un-resumable
// "ghosts" when the PTY exits before claude writes any JSONL.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { deleteIfGhostOnExit, cleanupGhostSessionsAtBoot } from "../src/ghost-session-cleanup.js";
import { encodeCwd, projectsRoot } from "../src/session-sync-service.js";

const A_SESSION = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B_SESSION = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function makeEnv() {
  const userland = mkdtempSync(join(tmpdir(), "oyster-ghost-"));
  const db = initDb(userland);
  const store = new SqliteSessionStore(db);
  return {
    userland,
    db,
    store,
    dispose: () => { db.close(); rmSync(userland, { recursive: true, force: true }); },
  };
}

function insertSession(db: Database.Database, id: string, cwd: string | null = null) {
  db.prepare(
    `INSERT INTO sessions (id, space_id, project_id, cwd, agent, state, started_at, last_event_at, assignment_mode)
     VALUES (?, NULL, NULL, ?, 'claude-code', 'disconnected', datetime('now'), datetime('now'), 'auto')`,
  ).run(id, cwd);
}

/** Write a fake JSONL at the path claude-code would use for (cwd, sessionId). */
function writeFakeJsonl(cwd: string, sessionId: string) {
  const dir = join(projectsRoot(), encodeCwd(cwd), "");
  // projectsRoot may be under $HOME — we can't write there. Override the
  // env var so the path lands in our temp tree instead.
  // (The env var is read fresh every call, so this is safe per test.)
  const fakeProjRoot = mkdtempSync(join(tmpdir(), "oyster-ghost-proj-"));
  process.env.OYSTER_CLAUDE_PROJECTS_ROOT = fakeProjRoot;
  const projectDir = join(fakeProjRoot, encodeCwd(cwd));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), '{"type":"text"}\n');
  return fakeProjRoot;
}

describe("deleteIfGhostOnExit", () => {
  let env: ReturnType<typeof makeEnv>;
  let fakeProjRoot: string | null = null;

  beforeEach(() => {
    env = makeEnv();
    fakeProjRoot = null;
  });

  afterEach(() => {
    env.dispose();
    if (fakeProjRoot) {
      rmSync(fakeProjRoot, { recursive: true, force: true });
      delete process.env.OYSTER_CLAUDE_PROJECTS_ROOT;
    }
  });

  it("deletes the row when no events AND no JSONL file exist", () => {
    const cwd = "/tmp/test-project";
    insertSession(env.db, A_SESSION, cwd);
    expect(env.store.getById(A_SESSION)).toBeDefined();

    const deleted = deleteIfGhostOnExit(env.store, env.db, A_SESSION, cwd);

    expect(deleted).toBe(true);
    expect(env.store.getById(A_SESSION)).toBeUndefined();
  });

  it("does NOT delete when JSONL exists (even with 0 events) — simulates watcher lag", () => {
    const cwd = "/tmp/test-project-2";
    insertSession(env.db, A_SESSION, cwd);
    fakeProjRoot = writeFakeJsonl(cwd, A_SESSION);

    const deleted = deleteIfGhostOnExit(env.store, env.db, A_SESSION, cwd);

    expect(deleted).toBe(false);
    expect(env.store.getById(A_SESSION)).toBeDefined();
  });

  it("does NOT delete when events exist (even with no JSONL)", () => {
    const cwd = "/tmp/test-project-3";
    insertSession(env.db, A_SESSION, cwd);
    env.store.insertEvent({ session_id: A_SESSION, role: "user", text: "hello" });

    const deleted = deleteIfGhostOnExit(env.store, env.db, A_SESSION, cwd);

    expect(deleted).toBe(false);
    expect(env.store.getById(A_SESSION)).toBeDefined();
  });
});

describe("cleanupGhostSessionsAtBoot", () => {
  let env: ReturnType<typeof makeEnv>;
  let fakeProjRoot: string | null = null;

  beforeEach(() => {
    env = makeEnv();
    fakeProjRoot = null;
  });

  afterEach(() => {
    env.dispose();
    if (fakeProjRoot) {
      rmSync(fakeProjRoot, { recursive: true, force: true });
      delete process.env.OYSTER_CLAUDE_PROJECTS_ROOT;
    }
  });

  it("cleans only ghosts and leaves real sessions alone", () => {
    const cwd = "/tmp/test-boot-project";
    // Ghost: no events, no JSONL.
    insertSession(env.db, A_SESSION, cwd);
    // Real: has an event.
    insertSession(env.db, B_SESSION, cwd);
    env.store.insertEvent({ session_id: B_SESSION, role: "user", text: "hi" });

    const { deleted } = cleanupGhostSessionsAtBoot(env.store, env.db);

    expect(deleted).toBe(1);
    expect(env.store.getById(A_SESSION)).toBeUndefined();
    expect(env.store.getById(B_SESSION)).toBeDefined();
  });

  it("is idempotent — second run deletes 0", () => {
    const cwd = "/tmp/test-boot-idempotent";
    insertSession(env.db, A_SESSION, cwd);

    const first = cleanupGhostSessionsAtBoot(env.store, env.db);
    expect(first.deleted).toBe(1);

    const second = cleanupGhostSessionsAtBoot(env.store, env.db);
    expect(second.deleted).toBe(0);
  });
});
