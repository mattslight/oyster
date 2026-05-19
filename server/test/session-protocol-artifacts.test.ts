// Coverage for #530: protocol-artifact classification keeps slash-command
// machinery (`<command-…>`, `<local-command-…>`, `<system-reminder>`) out of
// the rendered transcript and FTS index while preserving the raw row.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";

function seedSpace(db: Database.Database, id: string) {
  db.prepare(
    `INSERT INTO spaces (id, display_name, color, scan_status)
     VALUES (?, ?, ?, 'none')`,
  ).run(id, id, "#000");
}

function seedSession(db: Database.Database, id: string, spaceId: string) {
  db.prepare(
    `INSERT INTO sessions
       (id, space_id, cwd, agent, title, state,
        started_at, last_event_at)
     VALUES (?, ?, NULL, 'claude-code', ?, 'done',
             '2026-05-19T10:00:00Z', '2026-05-19T10:30:00Z')`,
  ).run(id, spaceId, id);
}

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "oyster-protocol-artifacts-"));
  const db = initDb(dir);
  const store = new SqliteSessionStore(db);
  seedSpace(db, "ws");
  seedSession(db, "s1", "ws");
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

describe("protocol-artifact classification", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.dispose(); });

  it("transcript reads exclude marked rows but preserve them on disk", () => {
    env.store.insertEvent({ session_id: "s1", role: "user", text: "first real question" });
    env.store.insertEvent({
      session_id: "s1",
      role: "user",
      text: "<command-name>/exit</command-name>",
      is_protocol_artifact: 1,
    });
    env.store.insertEvent({ session_id: "s1", role: "assistant", text: "the reply" });
    env.store.insertEvent({
      session_id: "s1",
      role: "user",
      text: "<system-reminder>noise</system-reminder>",
      is_protocol_artifact: 1,
    });

    // Transcript reads hide artefacts.
    expect(env.store.getEventsBySession("s1").map((e) => e.text))
      .toEqual(["first real question", "the reply"]);
    expect(env.store.getEventsBySession("s1", { limit: 10 }).map((e) => e.text))
      .toEqual(["first real question", "the reply"]);

    // Cursor pagination also hides them.
    const all = env.store.getEventsBySession("s1");
    const first = all[0]!;
    const last = all[all.length - 1]!;
    expect(env.store.getEventsAfterBySession("s1", first.id, 10).map((e) => e.text))
      .toEqual(["the reply"]);
    expect(env.store.getEventsBeforeBySession("s1", last.id, 10).map((e) => e.text))
      .toEqual(["first real question"]);

    // Raw rows are still on disk for audit.
    const allOnDisk = env.db
      .prepare("SELECT role, text, is_protocol_artifact FROM session_events WHERE session_id = ? ORDER BY id")
      .all("s1") as Array<{ role: string; text: string; is_protocol_artifact: number }>;
    expect(allOnDisk).toHaveLength(4);
    expect(allOnDisk.filter((r) => r.is_protocol_artifact === 1)).toHaveLength(2);
  });

  it("FTS search excludes artefacts via the gated trigger", () => {
    env.store.insertEvent({
      session_id: "s1",
      role: "user",
      text: "<command-name>/rename special-phrase-uniquetoken</command-name>",
      is_protocol_artifact: 1,
    });
    env.store.insertEvent({
      session_id: "s1",
      role: "user",
      text: "real prompt with special-phrase-uniquetoken in it",
    });

    const hits = env.store.searchEvents("special");
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain("real");
  });

  it("backfill marks pre-migration rows and pulls them out of FTS", () => {
    // Simulate pre-migration state: artefact rows inserted with the flag
    // still 0, so the (gated) AI trigger DID index them in FTS. The new
    // migration UPDATE flips the flag, which fires the AU triggers and
    // removes them from the inverted index.
    env.db.prepare(
      `INSERT INTO session_events (session_id, role, text, is_protocol_artifact)
       VALUES ('s1', 'user', ?, 0)`,
    ).run("<command-name>/exit needle-token</command-name>");
    env.db.prepare(
      `INSERT INTO session_events (session_id, role, text, is_protocol_artifact)
       VALUES ('s1', 'user', ?, 0)`,
    ).run("genuine question needle-token");

    // Sanity: pre-backfill, both rows match.
    expect(env.store.searchEvents("needle").map((h) => h.snippet).join("\n")).toContain("needle");
    expect(env.store.searchEvents("needle")).toHaveLength(2);

    // Re-run the backfill UPDATE (mirrors db.ts).
    env.db.exec(`
      UPDATE session_events
         SET is_protocol_artifact = 1
       WHERE is_protocol_artifact = 0
         AND role = 'user'
         AND (
           ltrim(text, ' ' || char(9) || char(10) || char(13)) LIKE '<local-command-%'
           OR ltrim(text, ' ' || char(9) || char(10) || char(13)) LIKE '<command-%'
           OR ltrim(text, ' ' || char(9) || char(10) || char(13)) LIKE '<system-reminder>%'
         );
    `);

    // Artefact gone from FTS; genuine row still matches.
    const hits = env.store.searchEvents("needle");
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain("genuine");

    // Transcript reads also exclude it now.
    expect(env.store.getEventsBySession("s1").map((e) => e.text))
      .toEqual(["genuine question needle-token"]);
  });

  it("assistant slash-command echoes are NOT classified as artefacts", () => {
    // The watcher gates classification on role === 'user', so an
    // assistant echo like `/rename …` stays visible and searchable.
    env.store.insertEvent({ session_id: "s1", role: "assistant", text: "/rename foo" });
    expect(env.store.getEventsBySession("s1").map((e) => e.text)).toEqual(["/rename foo"]);
    expect(env.store.searchEvents("rename")).toHaveLength(1);
  });

  it("messages that merely mention wrapper tags are not classified", () => {
    // Prefix-only match: a legit user message that happens to contain
    // `<command-` in its body stays visible.
    env.store.insertEvent({
      session_id: "s1",
      role: "user",
      text: "here's an example: <command-name> — what does that tag mean?",
    });
    expect(env.store.getEventsBySession("s1")).toHaveLength(1);
  });
});
