// Tests for the JSONL-side evidence capture in ClaudeCodeWatcher:
//   - `/exit` user events flip `explicit_exit_seen` to 1
//   - every assistant event with a `stop_reason` persists into
//     `last_assistant_stop_reason`
//
// Both signals feed `deriveState` (Task 5 of the session-status-palette plan).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeWatcher } from "../src/watchers/claude-code.js";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { SqliteArtifactStore } from "../src/artifact-store.js";

interface Env {
  watcher: ClaudeCodeWatcher;
  store: SqliteSessionStore;
  root: string;
  cleanup: () => Promise<void>;
}

function makeEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "oyster-watcher-evidence-"));
  const dbDir = mkdtempSync(join(tmpdir(), "oyster-watcher-evidence-db-"));
  const db = initDb(dbDir);
  const store = new SqliteSessionStore(db);
  const artifactStore = new SqliteArtifactStore(db);
  const watcher = new ClaudeCodeWatcher({
    sessionStore: store,
    artifactStore,
    lookupProject: () => ({ projectId: null, spaceId: null }),
    projectsRoot: root,
  });
  return {
    watcher,
    store,
    root,
    cleanup: async () => {
      await watcher.stop();
      db.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    },
  };
}

// Write a JSONL file under <root>/<encoded-cwd>/<sessionId>.jsonl and return
// the chosen sessionId. The boot scan picks it up when start() is called.
function writeJsonl(root: string, events: Array<Record<string, unknown>>): string {
  const sessionId = `00000000-0000-0000-0000-${Date.now().toString(16).padStart(12, "0")}`;
  const projectDir = join(root, "-tmp-fixture-cwd");
  mkdirSync(projectDir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), lines);
  return sessionId;
}

describe("claude-code watcher — evidence capture", () => {
  let env: Env;
  beforeEach(() => { env = makeEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it("sets explicit_exit_seen when the JSONL has a /exit user event", async () => {
    const sessionId = writeJsonl(env.root, [
      { type: "user", message: { content: "first" }, timestamp: new Date().toISOString() },
      { type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }, timestamp: new Date().toISOString() },
      { type: "user", message: { content: "/exit" }, timestamp: new Date().toISOString() },
    ]);

    await env.watcher.start();

    const row = env.store.getById(sessionId);
    expect(row).toBeDefined();
    expect(row!.explicit_exit_seen).toBe(1);
  });

  it("stores last assistant stop_reason in last_assistant_stop_reason", async () => {
    const sessionId = writeJsonl(env.root, [
      { type: "user", message: { content: "do it" }, timestamp: new Date().toISOString() },
      { type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash", input: {} }] }, timestamp: new Date().toISOString() },
    ]);

    await env.watcher.start();

    const row = env.store.getById(sessionId);
    expect(row).toBeDefined();
    expect(row!.last_assistant_stop_reason).toBe("tool_use");
  });

  it("end_turn updates last_assistant_stop_reason from a prior tool_use", async () => {
    const sessionId = writeJsonl(env.root, [
      { type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash", input: {} }] }, timestamp: new Date().toISOString() },
      { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] }, timestamp: new Date().toISOString() },
      { type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] }, timestamp: new Date().toISOString() },
    ]);

    await env.watcher.start();

    const row = env.store.getById(sessionId);
    expect(row).toBeDefined();
    expect(row!.last_assistant_stop_reason).toBe("end_turn");
  });

  it("leaves both fields untouched when no /exit and no assistant stop_reason are present", async () => {
    const sessionId = writeJsonl(env.root, [
      { type: "user", message: { content: "hello" }, timestamp: new Date().toISOString() },
    ]);

    await env.watcher.start();

    const row = env.store.getById(sessionId);
    expect(row).toBeDefined();
    expect(row!.explicit_exit_seen).toBe(0);
    expect(row!.last_assistant_stop_reason).toBeNull();
  });
});
