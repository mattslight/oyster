// Spotlight session-grouped search: verifies that searchSessions collapses
// multiple matching events into one row per session, picks the best-ranked
// event as the representative, and returns match_count.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";
import type Database from "better-sqlite3";

function seedSpace(db: Database.Database, id: string) {
  db.prepare(
    `INSERT INTO spaces (id, display_name, color, scan_status)
     VALUES (?, ?, ?, 'none')`,
  ).run(id, id, "#000");
}

function seedSession(
  db: Database.Database,
  fields: { id: string; title: string; space_id: string; last_event_at?: string },
) {
  db.prepare(
    `INSERT INTO sessions
       (id, space_id, cwd, agent, title, state,
        started_at, last_event_at)
     VALUES (?, ?, NULL, 'claude-code', ?, 'done',
             '2026-05-15T10:00:00Z', ?)`,
  ).run(fields.id, fields.space_id, fields.title, fields.last_event_at ?? "2026-05-15T10:30:00Z");
}

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "oyster-sess-search-"));
  const db = initDb(dir);
  const store = new SqliteSessionStore(db);
  return {
    dir,
    db,
    store,
    dispose: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("SqliteSessionStore.searchSessions", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.dispose(); });

  it("collapses many matches in one session into a single row", () => {
    seedSpace(env.db, "ws");
    seedSession(env.db, { id: "s1", title: "Big session", space_id: "ws" });
    // 5 events in the same session, all matching "deposit"
    for (let i = 0; i < 5; i++) {
      env.store.insertEvent({
        session_id: "s1",
        role: "assistant",
        text: `something about deposit number ${i}`,
      });
    }

    const hits = env.store.searchSessions("deposit");
    expect(hits).toHaveLength(1);
    expect(hits[0].session_id).toBe("s1");
    expect(hits[0].session_title).toBe("Big session");
    expect(hits[0].space_id).toBe("ws");
    expect(hits[0].match_count).toBe(5);
    expect(hits[0].snippet).toContain("[deposit]");
  });

  it("returns one row per matching session and excludes non-matching ones", () => {
    seedSpace(env.db, "ws");
    seedSession(env.db, { id: "a", title: "A", space_id: "ws" });
    seedSession(env.db, { id: "b", title: "B", space_id: "ws" });
    seedSession(env.db, { id: "c", title: "C", space_id: "ws" });
    env.store.insertEvent({ session_id: "a", role: "user", text: "talk about deposit cards" });
    env.store.insertEvent({ session_id: "b", role: "user", text: "no match here" });
    env.store.insertEvent({ session_id: "c", role: "user", text: "another deposit mention" });

    const hits = env.store.searchSessions("deposit");
    // Two matching sessions returned, the non-matching `b` is excluded.
    // Relative ordering between `a` and `c` is not asserted — their FTS
    // ranks are equivalent here and BM25 tie-break order is fragile to
    // assert on. A dedicated rank-ordering test below uses asymmetric
    // inputs to lock that in deterministically.
    expect(hits).toHaveLength(2);
    const ids = new Set(hits.map(h => h.session_id));
    expect(ids).toEqual(new Set(["a", "c"]));
    for (const h of hits) expect(h.match_count).toBe(1);
  });

  it("orders sessions by best FTS rank (stronger match first)", () => {
    seedSpace(env.db, "ws");
    seedSession(env.db, { id: "strong", title: "S", space_id: "ws" });
    seedSession(env.db, { id: "weak", title: "W", space_id: "ws" });
    // BM25 favours higher term frequency relative to doc length. A short
    // event that's just the query token outranks a long event where the
    // token appears once amongst many.
    env.store.insertEvent({ session_id: "strong", role: "user", text: "deposit" });
    env.store.insertEvent({
      session_id: "weak",
      role: "user",
      text: "lorem ipsum dolor sit amet consectetur adipiscing elit deposit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua",
    });

    const hits = env.store.searchSessions("deposit");
    expect(hits.map(h => h.session_id)).toEqual(["strong", "weak"]);
  });

  it("scopes by space_id when given", () => {
    seedSpace(env.db, "ws1");
    seedSpace(env.db, "ws2");
    seedSession(env.db, { id: "s1", title: "in ws1", space_id: "ws1" });
    seedSession(env.db, { id: "s2", title: "in ws2", space_id: "ws2" });
    env.store.insertEvent({ session_id: "s1", role: "user", text: "deposit one" });
    env.store.insertEvent({ session_id: "s2", role: "user", text: "deposit two" });

    const hits = env.store.searchSessions("deposit", { spaceId: "ws2" });
    expect(hits).toHaveLength(1);
    expect(hits[0].session_id).toBe("s2");
  });

  it("returns empty for queries with no alphanumeric chars", () => {
    seedSpace(env.db, "ws");
    seedSession(env.db, { id: "s1", title: "T", space_id: "ws" });
    env.store.insertEvent({ session_id: "s1", role: "user", text: "anything" });
    expect(env.store.searchSessions("???")).toEqual([]);
    expect(env.store.searchSessions("")).toEqual([]);
  });

  it("supports multi-word phrase queries", () => {
    seedSpace(env.db, "ws");
    seedSession(env.db, { id: "s1", title: "T", space_id: "ws" });
    env.store.insertEvent({ session_id: "s1", role: "user", text: "we need deposit cards now" });
    env.store.insertEvent({ session_id: "s1", role: "user", text: "deposit alone, no cards" });

    const hits = env.store.searchSessions("deposit cards");
    expect(hits).toHaveLength(1);
    // match_count counts events that match the phrase, not just events mentioning either word
    expect(hits[0].match_count).toBe(1);
  });
});
