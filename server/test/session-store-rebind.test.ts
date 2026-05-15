// rebindAutoSessionsForSource + getActiveSourceForCwd unit tests.
//
// The longest-prefix heuristic is the load-bearing invariant of the whole
// binding model: orphan auto rows bind, broad→specific auto rows move up,
// nothing demotes, manual rows are frozen. Each case here corresponds to a
// row of the "Behaviour when source.path changes A → B" table in the spec.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { SqliteSpaceStore } from "../src/space-store.js";
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

function makeStores(): { db: Database.Database; cleanup: () => void; sessionStore: SqliteSessionStore; spaceStore: SqliteSpaceStore } {
  const dir = mkdtempSync(join(tmpdir(), "oyster-rebind-"));
  const db = initDb(dir);
  return {
    db,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
    sessionStore: new SqliteSessionStore(db),
    spaceStore: new SqliteSpaceStore(db),
  };
}

describe("rebindAutoSessionsForSource (longest-prefix)", () => {
  let env: ReturnType<typeof makeStores>;
  beforeEach(() => { env = makeStores(); });
  afterEach(() => { env.cleanup(); });

  it("binds an orphan auto-session whose cwd exactly equals the source path", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "src", "sp", "/Users/me/scratch");
    seedSession(env.db, { id: "s", cwd: "/Users/me/scratch" });

    const n = env.sessionStore.rebindAutoSessionsForSource("sp", "src", "/Users/me/scratch");
    expect(n).toBe(1);
    expect(env.sessionStore.getById("s")?.source_id).toBe("src");
    expect(env.sessionStore.getById("s")?.space_id).toBe("sp");
  });

  it("binds an orphan auto-session whose cwd is a subdirectory of the source path", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "src", "sp", "/Users/me/scratch");
    seedSession(env.db, { id: "s", cwd: "/Users/me/scratch/web/src" });

    env.sessionStore.rebindAutoSessionsForSource("sp", "src", "/Users/me/scratch");
    expect(env.sessionStore.getById("s")?.source_id).toBe("src");
  });

  it("does NOT match a sibling whose name has the source as a prefix (the '/%' guard)", () => {
    // `/Users/me/scratch-old` starts with `/Users/me/scratch` but is not a
    // proper subdirectory — the trailing `/` in the LIKE pattern blocks it.
    seedSpace(env.db, "sp");
    seedSource(env.db, "src", "sp", "/Users/me/scratch");
    seedSession(env.db, { id: "s", cwd: "/Users/me/scratch-old" });

    const n = env.sessionStore.rebindAutoSessionsForSource("sp", "src", "/Users/me/scratch");
    expect(n).toBe(0);
    expect(env.sessionStore.getById("s")?.source_id).toBeNull();
  });

  it("prefers the longest matching source — orphan binds to the deeper one", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "broad", "sp", "/Users/me/scratch");
    seedSource(env.db, "deep", "sp", "/Users/me/scratch/web");
    seedSession(env.db, { id: "s", cwd: "/Users/me/scratch/web/src" });

    // Running rebind for the broad source should NOT capture the session,
    // because `deep` is a longer match.
    env.sessionStore.rebindAutoSessionsForSource("sp", "broad", "/Users/me/scratch");
    expect(env.sessionStore.getById("s")?.source_id).toBeNull();

    // Running for the deep source DOES bind it.
    env.sessionStore.rebindAutoSessionsForSource("sp", "deep", "/Users/me/scratch/web");
    expect(env.sessionStore.getById("s")?.source_id).toBe("deep");
  });

  it("'improve' case: auto-session bound to broad source moves up to a newly-attached deeper one", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "broad", "sp", "/Users/me/scratch");
    seedSession(env.db, {
      id: "s",
      cwd: "/Users/me/scratch/web/src",
      source_id: "broad",
      space_id: "sp",
    });

    // Now we attach a deeper source and run the heuristic for it.
    seedSource(env.db, "deep", "sp", "/Users/me/scratch/web");
    const n = env.sessionStore.rebindAutoSessionsForSource("sp", "deep", "/Users/me/scratch/web");
    expect(n).toBe(1);
    expect(env.sessionStore.getById("s")?.source_id).toBe("deep");
  });

  it("no demotion: auto-session bound to deeper source is NOT moved to a newly-attached broader one", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "deep", "sp", "/Users/me/scratch/web");
    seedSession(env.db, {
      id: "s",
      cwd: "/Users/me/scratch/web/src",
      source_id: "deep",
      space_id: "sp",
    });
    // Now attach a broader source and run rebind for it.
    seedSource(env.db, "broad", "sp", "/Users/me/scratch");
    const n = env.sessionStore.rebindAutoSessionsForSource("sp", "broad", "/Users/me/scratch");
    expect(n).toBe(0);
    expect(env.sessionStore.getById("s")?.source_id).toBe("deep");
  });

  it("manual rows are immune even when a longer-prefix source applies", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "deep", "sp", "/Users/me/scratch/web");
    seedSession(env.db, {
      id: "s",
      cwd: "/Users/me/scratch/web/src",
      source_id: null,
      space_id: "sp",
      assignment_mode: "manual",
    });
    const n = env.sessionStore.rebindAutoSessionsForSource("sp", "deep", "/Users/me/scratch/web");
    expect(n).toBe(0);
    expect(env.sessionStore.getById("s")?.source_id).toBeNull();
    expect(env.sessionStore.getById("s")?.assignment_mode).toBe("manual");
  });

  it("ignores rows with NULL cwd (nothing to match against)", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "src", "sp", "/Users/me/scratch");
    seedSession(env.db, { id: "s", cwd: null });
    const n = env.sessionStore.rebindAutoSessionsForSource("sp", "src", "/Users/me/scratch");
    expect(n).toBe(0);
  });

  it("a root path (POSIX `/`) binds its descendants", () => {
    // normaliseSourcePath preserves trailing `/` for roots; the substr
    // boundary check has to treat that trailing `/` as the anchor, not
    // demand a second `/` after the prefix.
    seedSpace(env.db, "sp");
    seedSource(env.db, "src", "sp", "/");
    seedSession(env.db, { id: "s", cwd: "/Users/me/proj" });
    env.sessionStore.rebindAutoSessionsForSource("sp", "src", "/");
    expect(env.sessionStore.getById("s")?.source_id).toBe("src");
  });

  it("a Windows drive root binds its descendants", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "src", "sp", "C:/");
    seedSession(env.db, { id: "s", cwd: "C:/Users/me/repo" });
    env.sessionStore.rebindAutoSessionsForSource("sp", "src", "C:/");
    expect(env.sessionStore.getById("s")?.source_id).toBe("src");
  });

  it("treats LIKE wildcards in path literally (no _ / % aliasing)", () => {
    // Real-world paths contain `_` constantly (`node_modules`, `my_repo`).
    // SQL LIKE treats `_` as a single-char wildcard, so an unescaped
    // implementation would mis-bind a cwd of `/repos/myXrepo/foo` to a
    // source at `/repos/my_repo`. The substr-based comparison treats `_`
    // (and `%`) literally.
    seedSpace(env.db, "sp");
    seedSource(env.db, "src", "sp", "/repos/my_repo");
    // Two orphan sessions: one is a genuine subdirectory match, one is a
    // similarly-named sibling that LIKE would have falsely matched.
    seedSession(env.db, { id: "real", cwd: "/repos/my_repo/web" });
    seedSession(env.db, { id: "ghost", cwd: "/repos/myXrepo/web" });
    env.sessionStore.rebindAutoSessionsForSource("sp", "src", "/repos/my_repo");
    expect(env.sessionStore.getById("real")?.source_id).toBe("src");
    expect(env.sessionStore.getById("ghost")?.source_id).toBeNull();
  });

  it("treats % in a path literally", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "src", "sp", "/repos/100%done");
    seedSession(env.db, { id: "real", cwd: "/repos/100%done/sub" });
    seedSession(env.db, { id: "ghost", cwd: "/repos/100AnythingDone/sub" });
    env.sessionStore.rebindAutoSessionsForSource("sp", "src", "/repos/100%done");
    expect(env.sessionStore.getById("real")?.source_id).toBe("src");
    expect(env.sessionStore.getById("ghost")?.source_id).toBeNull();
  });

  it("soft-deleted sources don't participate in the 'NOT EXISTS longer match' check", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "broad", "sp", "/Users/me/scratch");
    seedSource(env.db, "deep", "sp", "/Users/me/scratch/web");
    // Detach the deeper source.
    env.db.prepare("UPDATE sources SET removed_at = datetime('now') WHERE id = 'deep'").run();
    seedSession(env.db, { id: "s", cwd: "/Users/me/scratch/web/src" });

    // Now the broad source IS the longest active match.
    const n = env.sessionStore.rebindAutoSessionsForSource("sp", "broad", "/Users/me/scratch");
    expect(n).toBe(1);
    expect(env.sessionStore.getById("s")?.source_id).toBe("broad");
  });
});

describe("getActiveSourceForCwd (longest-prefix read)", () => {
  let env: ReturnType<typeof makeStores>;
  beforeEach(() => { env = makeStores(); });
  afterEach(() => { env.cleanup(); });

  it("returns the longest-prefix active source", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "broad", "sp", "/Users/me/scratch");
    seedSource(env.db, "deep", "sp", "/Users/me/scratch/web");
    const match = env.spaceStore.getActiveSourceForCwd("/Users/me/scratch/web/src");
    expect(match?.id).toBe("deep");
  });

  it("matches exact cwd against source path", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "src", "sp", "/Users/me/scratch");
    const match = env.spaceStore.getActiveSourceForCwd("/Users/me/scratch");
    expect(match?.id).toBe("src");
  });

  it("returns undefined when no source matches", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "src", "sp", "/Users/me/scratch");
    expect(env.spaceStore.getActiveSourceForCwd("/Users/me/elsewhere")).toBeUndefined();
  });

  it("does not match a sibling whose name extends the source path without a '/' (sibling guard)", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "src", "sp", "/Users/me/scratch");
    expect(env.spaceStore.getActiveSourceForCwd("/Users/me/scratch-old")).toBeUndefined();
  });

  it("matches descendants of a POSIX root source", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "src", "sp", "/");
    expect(env.spaceStore.getActiveSourceForCwd("/")?.id).toBe("src");
    expect(env.spaceStore.getActiveSourceForCwd("/anything/deep")?.id).toBe("src");
  });

  it("matches descendants of a Windows drive-root source", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "src", "sp", "C:/");
    expect(env.spaceStore.getActiveSourceForCwd("C:/Users/me")?.id).toBe("src");
  });

  it("treats _ in a source path literally (no LIKE wildcard aliasing)", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "src", "sp", "/repos/my_repo");
    expect(env.spaceStore.getActiveSourceForCwd("/repos/my_repo/sub")?.id).toBe("src");
    expect(env.spaceStore.getActiveSourceForCwd("/repos/myXrepo/sub")).toBeUndefined();
  });

  it("ignores soft-deleted sources", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "src", "sp", "/Users/me/scratch");
    env.db.prepare("UPDATE sources SET removed_at = datetime('now') WHERE id = 'src'").run();
    expect(env.spaceStore.getActiveSourceForCwd("/Users/me/scratch")).toBeUndefined();
  });
});

describe("detachSourceFromSessions", () => {
  let env: ReturnType<typeof makeStores>;
  beforeEach(() => { env = makeStores(); });
  afterEach(() => { env.cleanup(); });

  it("nulls source_id on every session pointing at the source, mode untouched", () => {
    seedSpace(env.db, "sp");
    seedSource(env.db, "src", "sp", "/p");
    seedSession(env.db, { id: "auto", cwd: "/p", source_id: "src", space_id: "sp" });
    seedSession(env.db, {
      id: "manual",
      cwd: "/p",
      source_id: "src",
      space_id: "sp",
      assignment_mode: "manual",
    });
    seedSession(env.db, { id: "other", cwd: "/q", source_id: null, space_id: null });

    const n = env.sessionStore.detachSourceFromSessions("src");
    expect(n).toBe(2);
    expect(env.sessionStore.getById("auto")?.source_id).toBeNull();
    expect(env.sessionStore.getById("auto")?.assignment_mode).toBe("auto");
    expect(env.sessionStore.getById("manual")?.source_id).toBeNull();
    expect(env.sessionStore.getById("manual")?.assignment_mode).toBe("manual"); // mode untouched
    expect(env.sessionStore.getById("other")?.source_id).toBeNull(); // unaffected
  });
});
