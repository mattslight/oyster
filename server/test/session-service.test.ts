// SessionService unit tests — the surface REST and MCP both call into.
// Covers the four manual/auto flip paths plus the atomic "Let Oyster
// decide" recompute.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { SqliteSpaceStore } from "../src/space-store.js";
import { SessionService, SessionNotFoundError, SourceNotFoundError, InvalidMoveSessionInputError } from "../src/session-service.js";
import type Database from "better-sqlite3";

function seedSpace(db: Database.Database, id: string) {
  db.prepare(
    `INSERT INTO spaces (id, display_name, color, scan_status)
     VALUES (?, ?, ?, 'none')`,
  ).run(id, id, "#000");
}

function seedSource(db: Database.Database, id: string, spaceId: string, path: string) {
  db.prepare(
    `INSERT INTO sources (id, space_id, type, path) VALUES (?, ?, 'local_folder', ?)`,
  ).run(id, spaceId, path);
}

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
  const dir = mkdtempSync(join(tmpdir(), "oyster-sess-svc-"));
  const db = initDb(dir);
  const sessionStore = new SqliteSessionStore(db);
  const spaceStore = new SqliteSpaceStore(db);
  const service = new SessionService(db, sessionStore, spaceStore);
  return {
    db, sessionStore, spaceStore, service,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe("SessionService.moveSession", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it("source_id: '<id>' → binds, flips to manual, derives space_id from source", () => {
    seedSpace(env.db, "sp1");
    seedSource(env.db, "src1", "sp1", "/p");
    seedSession(env.db, { id: "s", cwd: "/somewhere" });

    const updated = env.service.moveSession({ session_id: "s", source_id: "src1" });
    expect(updated.source_id).toBe("src1");
    expect(updated.space_id).toBe("sp1");
    expect(updated.assignment_mode).toBe("manual");
  });

  it("cross-space move with no space_id: derives space from the new source", () => {
    seedSpace(env.db, "sp1");
    seedSpace(env.db, "sp2");
    seedSource(env.db, "src1", "sp1", "/p1");
    seedSource(env.db, "src2", "sp2", "/p2");
    seedSession(env.db, { id: "s", cwd: "/p1", source_id: "src1", space_id: "sp1" });

    const updated = env.service.moveSession({ session_id: "s", source_id: "src2" });
    expect(updated.source_id).toBe("src2");
    expect(updated.space_id).toBe("sp2");
    expect(updated.assignment_mode).toBe("manual");
  });

  it("rejects an inconsistent (source_id, space_id) pair instead of silently overriding", () => {
    seedSpace(env.db, "sp1");
    seedSpace(env.db, "sp2");
    seedSource(env.db, "src1", "sp1", "/p1");
    seedSource(env.db, "src2", "sp2", "/p2");
    seedSession(env.db, { id: "s", cwd: "/p1", source_id: "src1", space_id: "sp1" });

    // Caller passes a space_id that disagrees with the source's space.
    // Previous behaviour silently overrode body.space_id; new behaviour
    // surfaces the bug to the caller.
    expect(() => env.service.moveSession({
      session_id: "s",
      source_id: "src2",
      space_id: "sp1",
    })).toThrow(/does not match/);
  });

  it("source_id: null → unbinds to vault, flips to manual", () => {
    seedSpace(env.db, "sp1");
    seedSource(env.db, "src1", "sp1", "/p");
    seedSession(env.db, { id: "s", source_id: "src1", space_id: "sp1" });

    const updated = env.service.moveSession({ session_id: "s", source_id: null });
    expect(updated.source_id).toBeNull();
    expect(updated.space_id).toBe("sp1"); // kept current
    expect(updated.assignment_mode).toBe("manual");
  });

  it("source_id: null with explicit space_id → moves to a different vault, manual", () => {
    seedSpace(env.db, "sp1");
    seedSpace(env.db, "sp2");
    seedSession(env.db, { id: "s", space_id: "sp1" });

    const updated = env.service.moveSession({
      session_id: "s",
      source_id: null,
      space_id: "sp2",
    });
    expect(updated.source_id).toBeNull();
    expect(updated.space_id).toBe("sp2");
    expect(updated.assignment_mode).toBe("manual");
  });

  it("assignment_mode: 'manual' alone → freezes current binding without changing source", () => {
    seedSpace(env.db, "sp1");
    seedSource(env.db, "src1", "sp1", "/p");
    seedSession(env.db, { id: "s", source_id: "src1", space_id: "sp1" });

    const updated = env.service.moveSession({ session_id: "s", assignment_mode: "manual" });
    expect(updated.source_id).toBe("src1");
    expect(updated.assignment_mode).toBe("manual");
  });

  it("404s on unknown session", () => {
    expect(() => env.service.moveSession({ session_id: "nope", source_id: null })).toThrow(SessionNotFoundError);
  });

  it("404s on unknown source", () => {
    seedSession(env.db, { id: "s" });
    expect(() => env.service.moveSession({ session_id: "s", source_id: "nope" })).toThrow(SourceNotFoundError);
  });

  it("rejects an empty body (nothing to change)", () => {
    seedSession(env.db, { id: "s" });
    expect(() => env.service.moveSession({ session_id: "s" }))
      .toThrow(InvalidMoveSessionInputError);
  });

  it("rejects space_id-only changes on a sourced session (would leave the pair inconsistent)", () => {
    seedSpace(env.db, "sp1");
    seedSpace(env.db, "sp2");
    seedSource(env.db, "src1", "sp1", "/p");
    seedSession(env.db, { id: "s", source_id: "src1", space_id: "sp1" });
    expect(() => env.service.moveSession({ session_id: "s", space_id: "sp2" }))
      .toThrow(/space_id can only be changed when source_id is null/);
  });

  it("rejects pure space_id-change on an unsourced session when assignment_mode is omitted", () => {
    seedSpace(env.db, "sp1");
    seedSpace(env.db, "sp2");
    seedSession(env.db, { id: "s", source_id: null, space_id: "sp1" });
    // For an unsourced session, space_id IS allowed to change — but we
    // still need an explicit assignment_mode rather than silently
    // defaulting to 'manual' as the old code did.
    expect(() => env.service.moveSession({ session_id: "s", space_id: "sp2" }))
      .toThrow(/assignment_mode is required/);
  });

  it("accepts space_id change on an unsourced session with explicit mode", () => {
    seedSpace(env.db, "sp1");
    seedSpace(env.db, "sp2");
    seedSession(env.db, { id: "s", source_id: null, space_id: "sp1" });
    const updated = env.service.moveSession({
      session_id: "s",
      space_id: "sp2",
      assignment_mode: "manual",
    });
    expect(updated.space_id).toBe("sp2");
    expect(updated.source_id).toBeNull();
    expect(updated.assignment_mode).toBe("manual");
  });

  it("404s on soft-deleted source", () => {
    seedSpace(env.db, "sp1");
    seedSource(env.db, "src1", "sp1", "/p");
    env.db.prepare("UPDATE sources SET removed_at = datetime('now') WHERE id = 'src1'").run();
    seedSession(env.db, { id: "s" });
    expect(() => env.service.moveSession({ session_id: "s", source_id: "src1" })).toThrow(SourceNotFoundError);
  });
});

describe("SessionService.resetSessionToAuto (and the assignment_mode:'auto' branch)", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it("recomputes via longest-prefix and binds to the deepest matching source", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "broad", "sp", "/Users/me/scratch");
    seedSource(env.db, "deep", "sp", "/Users/me/scratch/web");
    seedSession(env.db, {
      id: "s",
      cwd: "/Users/me/scratch/web/src",
      source_id: null,
      space_id: null,
      assignment_mode: "manual",
    });

    const updated = env.service.resetSessionToAuto("s");
    expect(updated.source_id).toBe("deep");
    expect(updated.space_id).toBe("sp");
    expect(updated.assignment_mode).toBe("auto");
  });

  it("ends up orphan + auto when no source matches the cwd", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "src", "sp", "/elsewhere");
    seedSession(env.db, {
      id: "s",
      cwd: "/somewhere",
      source_id: null,
      assignment_mode: "manual",
    });

    const updated = env.service.resetSessionToAuto("s");
    expect(updated.source_id).toBeNull();
    expect(updated.space_id).toBeNull();
    expect(updated.assignment_mode).toBe("auto");
  });

  it("works on a row with NULL cwd — no crash, just orphan + auto", () => {
    seedSession(env.db, { id: "s", cwd: null, assignment_mode: "manual" });
    const updated = env.service.resetSessionToAuto("s");
    expect(updated.source_id).toBeNull();
    expect(updated.assignment_mode).toBe("auto");
  });

  it("rejects assignment_mode: 'auto' combined with an explicit space_id (would be silently ignored)", () => {
    seedSpace(env.db, "sp");
    seedSession(env.db, { id: "s", space_id: "sp", assignment_mode: "manual" });
    expect(() => env.service.moveSession({
      session_id: "s",
      assignment_mode: "auto",
      space_id: "sp",
    })).toThrow(/cannot be combined with assignment_mode: 'auto'/);
  });

  it("moveSession({ assignment_mode: 'auto' }) without source_id delegates to resetSessionToAuto", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "src", "sp", "/p");
    seedSession(env.db, {
      id: "s",
      cwd: "/p/sub",
      source_id: null,
      assignment_mode: "manual",
    });
    const updated = env.service.moveSession({ session_id: "s", assignment_mode: "auto" });
    expect(updated.source_id).toBe("src");
    expect(updated.assignment_mode).toBe("auto");
  });
});

// New project-shaped moveSession surface. Once these go green and the UI
// + MCP are swapped over, the source_id / assignment_mode / space_id
// branches above can be deleted along with their tests.

function seedProject(db: Database.Database, id: string, spaceId: string, name: string) {
  db.prepare(
    `INSERT INTO projects (id, space_id, name) VALUES (?, ?, ?)`,
  ).run(id, spaceId, name);
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
