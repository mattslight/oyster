// Boot-time dedup: collapse artefact rows that point at the same path
// after the tombstone-recovery pass. Two rows at one path is the
// expected outcome of the user's history (the old path got recovered to
// the new path, AND a separate row already existed at the new path).
// Winner: most session_artifacts touches → tiebreaker most recent
// created_at. session_artifacts links migrate from losers to winner;
// losers soft-deleted.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

describe("initDb artefact dedup by path", () => {
  let userland: string;
  beforeEach(() => { userland = mkdtempSync(join(tmpdir(), "oyster-adp-")); });
  afterEach(() => { rmSync(userland, { recursive: true, force: true }); });

  function seedSession(db: ReturnType<typeof initDb>, id: string) {
    db.prepare(
      "INSERT INTO sessions (id, agent, state) VALUES (?, 'claude-code', 'done')",
    ).run(id);
  }

  function seedArtifact(db: ReturnType<typeof initDb>, id: string, path: string, createdAt: string) {
    db.prepare(
      `INSERT INTO artifacts (id, space_id, label, artifact_kind, storage_kind, storage_config, runtime_kind, runtime_config, created_at)
       VALUES (?, 'home', ?, 'notes', 'filesystem', ?, 'static_file', '{}', ?)`,
    ).run(id, id, JSON.stringify({ path }), createdAt);
  }

  function link(db: ReturnType<typeof initDb>, sessionId: string, artifactId: string, role: string = "read") {
    db.prepare(
      "INSERT INTO session_artifacts (session_id, artifact_id, role) VALUES (?, ?, ?)",
    ).run(sessionId, artifactId, role);
  }

  it("two rows at same path → keep the one with more touches, migrate links, soft-delete the other", () => {
    let db = initDb(userland);
    const path = "/some/abs/path/report.md";
    seedSession(db, "s1");
    seedSession(db, "s2");
    seedArtifact(db, "loser",  path, "2026-05-14 10:00:00");
    seedArtifact(db, "winner", path, "2026-05-14 12:00:00");
    link(db, "s1", "loser",  "read");
    link(db, "s1", "winner", "read"); // (s1, winner, read) — winner has 2
    link(db, "s2", "winner", "read");
    db.close();

    db = initDb(userland);
    const winnerRow = db.prepare("SELECT removed_at FROM artifacts WHERE id = 'winner'").get() as { removed_at: string | null };
    const loserRow = db.prepare("SELECT removed_at FROM artifacts WHERE id = 'loser'").get() as { removed_at: string | null };
    expect(winnerRow.removed_at).toBeNull();
    expect(loserRow.removed_at).not.toBeNull();

    // session_artifacts: loser's (s1, read) link folds into winner's existing one (no dup).
    const linksToWinner = db.prepare("SELECT session_id FROM session_artifacts WHERE artifact_id = 'winner' ORDER BY session_id").all() as Array<{ session_id: string }>;
    expect(linksToWinner.map((r) => r.session_id)).toEqual(["s1", "s2"]);
    const linksToLoser = db.prepare("SELECT COUNT(*) AS c FROM session_artifacts WHERE artifact_id = 'loser'").get() as { c: number };
    expect(linksToLoser.c).toBe(0);
    db.close();
  });

  it("tiebreaker on link-count is most-recent created_at", () => {
    let db = initDb(userland);
    const path = "/abs/tie/x.md";
    seedSession(db, "s1");
    seedArtifact(db, "older", path, "2026-05-14 09:00:00");
    seedArtifact(db, "newer", path, "2026-05-14 15:00:00");
    link(db, "s1", "older", "read");
    link(db, "s1", "newer", "create"); // both have 1 touch
    db.close();

    db = initDb(userland);
    const newer = db.prepare("SELECT removed_at FROM artifacts WHERE id = 'newer'").get() as { removed_at: string | null };
    const older = db.prepare("SELECT removed_at FROM artifacts WHERE id = 'older'").get() as { removed_at: string | null };
    expect(newer.removed_at).toBeNull();
    expect(older.removed_at).not.toBeNull();
    db.close();
  });

  it("single row at a path → untouched", () => {
    let db = initDb(userland);
    seedArtifact(db, "solo", "/abs/solo/x.md", "2026-05-14 10:00:00");
    db.close();

    db = initDb(userland);
    const row = db.prepare("SELECT removed_at FROM artifacts WHERE id = 'solo'").get() as { removed_at: string | null };
    expect(row.removed_at).toBeNull();
    db.close();
  });

  it("ignores already-tombstoned rows when picking a winner", () => {
    let db = initDb(userland);
    const path = "/abs/ts/y.md";
    seedArtifact(db, "alive", path, "2026-05-14 10:00:00");
    db.prepare(
      `INSERT INTO artifacts (id, space_id, label, artifact_kind, storage_kind, storage_config, runtime_kind, runtime_config, created_at, removed_at)
       VALUES ('dead', 'home', 'd', 'notes', 'filesystem', ?, 'static_file', '{}', '2026-05-14 09:00:00', datetime('now'))`,
    ).run(JSON.stringify({ path }));
    db.close();

    db = initDb(userland);
    const alive = db.prepare("SELECT removed_at FROM artifacts WHERE id = 'alive'").get() as { removed_at: string | null };
    expect(alive.removed_at).toBeNull(); // not re-tombstoned
    db.close();
  });
});
