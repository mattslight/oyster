// SessionService unit tests — the surface REST and MCP both call into.
// Covers the project_id branches of moveSession (post sources→projects).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { SessionService, SessionNotFoundError } from "../src/session-service.js";
import type Database from "better-sqlite3";

function seedSpace(db: Database.Database, id: string) {
  db.prepare(
    `INSERT INTO spaces (id, display_name, color, scan_status)
     VALUES (?, ?, ?, 'none')`,
  ).run(id, id, "#000");
}

function seedSession(
  db: Database.Database,
  fields: {
    id: string;
    cwd?: string | null;
    space_id?: string | null;
  },
) {
  db.prepare(
    `INSERT INTO sessions
       (id, space_id, cwd, agent, title, state,
        started_at, last_event_at)
     VALUES (?, ?, ?, 'claude-code', 't', 'done',
             '2026-05-15T10:00:00Z', '2026-05-15T10:30:00Z')`,
  ).run(
    fields.id,
    fields.space_id ?? null,
    fields.cwd ?? null,
  );
}

function seedProject(db: Database.Database, id: string, spaceId: string, name: string) {
  db.prepare(
    `INSERT INTO projects (id, space_id, name) VALUES (?, ?, ?)`,
  ).run(id, spaceId, name);
}

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "oyster-sess-svc-"));
  const db = initDb(dir);
  const sessionStore = new SqliteSessionStore(db);
  const service = new SessionService(db, sessionStore);
  return {
    db, sessionStore, service,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe("SessionService.moveSession with project_id", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it("project_id: '<id>' → binds, derives space_id from project", () => {
    seedSpace(env.db, "sp1");
    seedProject(env.db, "p1", "sp1", "Proj");
    seedSession(env.db, { id: "s" });

    const updated = env.service.moveSession({ session_id: "s", project_id: "p1" });
    expect(updated.project_id).toBe("p1");
    expect(updated.space_id).toBe("sp1");
  });

  it("project_id: null → clears project, keeps space_id", () => {
    seedSpace(env.db, "sp1");
    seedProject(env.db, "p1", "sp1", "Proj");
    seedSession(env.db, { id: "s", space_id: "sp1" });
    env.db.prepare("UPDATE sessions SET project_id = 'p1' WHERE id = 's'").run();

    const updated = env.service.moveSession({ session_id: "s", project_id: null });
    expect(updated.project_id).toBeNull();
    expect(updated.space_id).toBe("sp1");
  });

  it("cross-space move via project_id: derives space from the new project", () => {
    seedSpace(env.db, "sp1");
    seedSpace(env.db, "sp2");
    seedProject(env.db, "p1", "sp1", "P1");
    seedProject(env.db, "p2", "sp2", "P2");
    seedSession(env.db, { id: "s", space_id: "sp1" });
    env.db.prepare("UPDATE sessions SET project_id = 'p1' WHERE id = 's'").run();

    const updated = env.service.moveSession({ session_id: "s", project_id: "p2" });
    expect(updated.project_id).toBe("p2");
    expect(updated.space_id).toBe("sp2");
  });

  it("404s on unknown project", () => {
    seedSession(env.db, { id: "s" });
    expect(() => env.service.moveSession({ session_id: "s", project_id: "nope" }))
      .toThrow(/Project/);
  });

  it("404s on soft-deleted project", () => {
    seedSpace(env.db, "sp1");
    seedProject(env.db, "p1", "sp1", "Proj");
    env.db.prepare("UPDATE projects SET removed_at = datetime('now') WHERE id = 'p1'").run();
    seedSession(env.db, { id: "s" });
    expect(() => env.service.moveSession({ session_id: "s", project_id: "p1" }))
      .toThrow(/Project/);
  });

  it("404s on unknown session", () => {
    seedSpace(env.db, "sp1");
    seedProject(env.db, "p1", "sp1", "Proj");
    expect(() => env.service.moveSession({ session_id: "nope", project_id: "p1" }))
      .toThrow(SessionNotFoundError);
  });
});
