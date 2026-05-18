// Tests for `ClaudeCodeWatcher.onceNewJsonl` — the auto-link lookup used by
// the terminal route to map a freshly spawned `claude` process to the
// session UUID it creates.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeWatcher } from "../src/watchers/claude-code.js";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { SqliteArtifactStore } from "../src/artifact-store.js";

function makeWatcher(root: string) {
  const dir = mkdtempSync(join(tmpdir(), "oyster-once-jsonl-db-"));
  const db = initDb(dir);
  const sessionStore = new SqliteSessionStore(db);
  const artifactStore = new SqliteArtifactStore(db);
  const watcher = new ClaudeCodeWatcher({
    sessionStore,
    artifactStore,
    lookupProject: () => ({ projectId: null, spaceId: null }),
    projectsRoot: root,
  });
  return { watcher, db, cleanupDb: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("ClaudeCodeWatcher.onceNewJsonl", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oyster-once-jsonl-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves null with no matches before the timeout", async () => {
    const { watcher, cleanupDb } = makeWatcher(root);
    try {
      const result = await watcher.onceNewJsonl("-encoded-cwd", Date.now(), 200);
      expect(result).toBeNull();
    } finally {
      await watcher.stop();
      cleanupDb();
    }
  });

  it("resolves the only qualifying file via sync scan", async () => {
    const sessDir = join(root, "-encoded");
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(join(sessDir, "session-abc.jsonl"), "{}\n");

    const { watcher, cleanupDb } = makeWatcher(root);
    try {
      // sinceMs slightly in the past so the file is "fresh" enough.
      const result = await watcher.onceNewJsonl("-encoded", Date.now() - 2000, 200);
      expect(result).toEqual({ sessionId: "session-abc" });
    } finally {
      await watcher.stop();
      cleanupDb();
    }
  });

  it("resolves null when two qualifying files appear (ambiguous)", async () => {
    const sessDir = join(root, "-encoded");
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(join(sessDir, "s1.jsonl"), "{}\n");
    writeFileSync(join(sessDir, "s2.jsonl"), "{}\n");

    const { watcher, cleanupDb } = makeWatcher(root);
    try {
      const result = await watcher.onceNewJsonl("-encoded", Date.now() - 2000, 200);
      expect(result).toBeNull();
    } finally {
      await watcher.stop();
      cleanupDb();
    }
  });

  it("never throws even if the directory doesn't exist", async () => {
    const { watcher, cleanupDb } = makeWatcher(root);
    try {
      const result = await watcher.onceNewJsonl("-no-such-encoded", Date.now(), 200);
      expect(result).toBeNull();
    } finally {
      await watcher.stop();
      cleanupDb();
    }
  });
});
