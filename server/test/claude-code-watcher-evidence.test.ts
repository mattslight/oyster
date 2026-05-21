// Tests for the JSONL-side evidence capture in ClaudeCodeWatcher:
//   - `/exit` user events flip `explicit_exit_seen` to 1
//   - every assistant event with a `stop_reason` persists into
//     `last_assistant_stop_reason`
//
// Both signals feed `deriveState` (Task 5 of the session-status-palette plan).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeWatcher } from "../src/watchers/claude-code.js";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { SqliteArtifactStore } from "../src/artifact-store.js";

// The exact wire shape Claude Code persists when the user invokes `/exit`:
// the slash command is templated into a wrapper inside `message.content`
// BEFORE the line is written to JSONL. Verified empirically against
// ~/.claude/projects/*/*.jsonl (0 raw `/exit` vs 73 wrapped events).
const EXIT_WRAPPED =
  "<command-name>/exit</command-name>\n            <command-message>exit</command-message>\n            <command-args></command-args>";

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

  it("sets explicit_exit_seen when the JSONL has a wrapped /exit user event", async () => {
    const sessionId = writeJsonl(env.root, [
      { type: "user", message: { content: "first" }, timestamp: new Date().toISOString() },
      { type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }, timestamp: new Date().toISOString() },
      { type: "user", message: { role: "user", content: EXIT_WRAPPED }, timestamp: new Date().toISOString() },
    ]);

    await env.watcher.start();

    const row = env.store.getById(sessionId);
    expect(row).toBeDefined();
    expect(row!.explicit_exit_seen).toBe(1);
  });

  it("does NOT set explicit_exit_seen on a bare '/exit' user content (not the real wire shape)", async () => {
    // In production, Claude Code never persists a raw "/exit" — it always
    // wraps the slash command in <command-name>…</command-name> before write.
    // A bare "/exit" is paste/echo/test noise, not the invocation, so it must
    // not flip the flag.
    const sessionId = writeJsonl(env.root, [
      { type: "user", message: { role: "user", content: "first" }, timestamp: new Date().toISOString() },
      { type: "user", message: { role: "user", content: "/exit" }, timestamp: new Date().toISOString() },
    ]);

    await env.watcher.start();

    const row = env.store.getById(sessionId);
    expect(row).toBeDefined();
    expect(row!.explicit_exit_seen).toBe(0);
  });

  it("does NOT set explicit_exit_seen when an assistant message contains the wrapper substring", async () => {
    // The user-branch only inspects ev.type === "user" events. An assistant
    // message that happens to mention the wrapper (e.g. discussing how /exit
    // is encoded) must not trip the matcher.
    const sessionId = writeJsonl(env.root, [
      { type: "user", message: { role: "user", content: "how does /exit get persisted?" }, timestamp: new Date().toISOString() },
      {
        type: "assistant",
        message: {
          stop_reason: "end_turn",
          content: [{ type: "text", text: `Claude Code wraps it as ${EXIT_WRAPPED}` }],
        },
        timestamp: new Date().toISOString(),
      },
    ]);

    await env.watcher.start();

    const row = env.store.getById(sessionId);
    expect(row).toBeDefined();
    expect(row!.explicit_exit_seen).toBe(0);
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

  it("sets explicit_exit_seen on a wrapped /exit appended AFTER watcher.start (live ingest)", async () => {
    // Previous tests all write the JSONL first, then call start() — only
    // exercising the `backfillRange` path. This test exercises the
    // live-ingest path: start the watcher on a short JSONL, then append the
    // wrapped /exit line and wait for chokidar's change event to fire.
    const sessionId = `00000000-0000-0000-0000-${Date.now().toString(16).padStart(12, "0")}`;
    const projectDir = join(env.root, "-tmp-fixture-cwd");
    mkdirSync(projectDir, { recursive: true });
    const filePath = join(projectDir, `${sessionId}.jsonl`);
    const initial = JSON.stringify({
      type: "user",
      message: { role: "user", content: "first" },
      timestamp: new Date().toISOString(),
    }) + "\n";
    writeFileSync(filePath, initial);

    await env.watcher.start();

    // Sanity: backfill picked up the initial line but didn't set the flag.
    expect(env.store.getById(sessionId)!.explicit_exit_seen).toBe(0);

    // Append the wrapped /exit and wait for the watcher tick to ingest it.
    appendFileSync(filePath, JSON.stringify({
      type: "user",
      message: { role: "user", content: EXIT_WRAPPED },
      timestamp: new Date().toISOString(),
    }) + "\n");

    // Poll briefly — chokidar's debounce + the file lock can take a moment.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (env.store.getById(sessionId)!.explicit_exit_seen === 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(env.store.getById(sessionId)!.explicit_exit_seen).toBe(1);
  });
});
