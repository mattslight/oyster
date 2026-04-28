// Smoke test for Sprint 2 (#251) — claude-code JSONL watcher.
// Runs the real watcher against a synthetic ~/.claude/projects layout,
// asserts session rows / events / artifact touches land correctly.
// Run: npx tsx scripts/smoke-claude-code-watcher.ts
//
// This is an ad-hoc smoke script (no test framework in the server package).
// It will be replaced by proper unit tests in a follow-up.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import { SqliteSpaceStore } from "../src/space-store.js";
import { SqliteArtifactStore } from "../src/artifact-store.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { ClaudeCodeWatcher } from "../src/watchers/claude-code.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  // Isolated workspace
  const root = mkdtempSync(join(tmpdir(), "oyster-watcher-smoke-"));
  console.log("[smoke] root:", root);

  // The watcher uses better-sqlite3 directly. initDb expects a userland dir
  // and writes oyster.db inside it.
  const dbDir = join(root, "db");
  mkdirSync(dbDir, { recursive: true });
  const db = initDb(dbDir);

  const spaceStore = new SqliteSpaceStore(db);
  const artifactStore = new SqliteArtifactStore(db);
  const sessionStore = new SqliteSessionStore(db);

  // Seed a space + source so cwd → space resolution has something to match.
  const fakeCwd = join(root, "fake-project");
  mkdirSync(fakeCwd, { recursive: true });
  spaceStore.insert({
    id: "test-space",
    display_name: "Test Space",
    color: null,
    parent_id: null,
    scan_status: "none",
    scan_error: null,
    last_scanned_at: null,
    last_scan_summary: null,
    ai_job_status: null,
    ai_job_error: null,
    summary_title: null,
    summary_content: null,
  });
  spaceStore.addSource({
    id: "src-1",
    space_id: "test-space",
    type: "local_folder",
    path: fakeCwd,
    label: null,
  });

  // Seed an artifact so artifact-touch logic finds a match.
  const trackedFile = join(fakeCwd, "README.md");
  writeFileSync(trackedFile, "# hi\n");
  artifactStore.insert({
    id: "art-1",
    owner_id: null,
    space_id: "test-space",
    label: "README",
    artifact_kind: "notes",
    storage_kind: "filesystem",
    storage_config: JSON.stringify({ path: trackedFile }),
    runtime_kind: "static",
    runtime_config: "{}",
    group_name: null,
    source_origin: "discovered",
    source_ref: null,
    source_id: null,
  });

  // ── Start the watcher pointed at our synthetic projects root ──
  const projectsRoot = join(root, "projects");
  mkdirSync(projectsRoot, { recursive: true });

  const sessionEvents: string[] = [];
  const watcher = new ClaudeCodeWatcher({
    sessionStore,
    spaceStore,
    artifactStore,
    projectsRoot,
    emitSessionChanged: (id) => sessionEvents.push(id),
  });
  await watcher.start();
  console.log("[smoke] watcher started");

  // ── Phase 1: brand-new session file appears, with one user event ──
  const projectDir = join(projectsRoot, "-Users-Test-fake-project");
  mkdirSync(projectDir, { recursive: true });
  const sessionId = "00000000-aaaa-bbbb-cccc-111111111111";
  const jsonlPath = join(projectDir, `${sessionId}.jsonl`);

  const userEvent = {
    type: "user",
    sessionId,
    cwd: fakeCwd,
    timestamp: "2026-04-28T12:00:00.000Z",
    message: { role: "user", content: "fix the README typo" },
  };
  writeFileSync(jsonlPath, JSON.stringify(userEvent) + "\n");

  // chokidar's `add` typically fires within 100–300ms of the syscall.
  await sleep(800);

  let session = sessionStore.getById(sessionId);
  assert(session, "session row should exist after first event");
  assert.equal(session.id, sessionId);
  assert.equal(session.space_id, "test-space", "cwd should resolve to test-space");
  assert.equal(session.agent, "claude-code");
  assert.equal(session.title, "fix the README typo");
  assert.equal(session.state, "running");
  console.log("[smoke] phase 1 ok — session row created with title + space");

  // ── Phase 2: assistant turn with text + tool_use(Read) on tracked file ──
  const assistantEvent = {
    type: "assistant",
    sessionId,
    cwd: fakeCwd,
    timestamp: "2026-04-28T12:00:05.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4-7",
      content: [
        { type: "text", text: "Let me read the README." },
        { type: "tool_use", id: "tu1", name: "Read", input: { file_path: trackedFile } },
      ],
    },
  };
  appendFileSync(jsonlPath, JSON.stringify(assistantEvent) + "\n");
  await sleep(500);

  const events = sessionStore.getEventsBySession(sessionId);
  assert(events.length >= 2, `expected ≥2 events, got ${events.length}`);
  const userRow = events.find((e) => e.role === "user");
  const assistantRow = events.find((e) => e.role === "assistant");
  assert(userRow && /fix the README/.test(userRow.text));
  assert(assistantRow && /Let me read/.test(assistantRow.text));

  const touches = sessionStore.getArtifactsBySession(sessionId);
  assert.equal(touches.length, 1, "expected one artifact touch");
  assert.equal(touches[0].artifact_id, "art-1");
  assert.equal(touches[0].role, "read");

  session = sessionStore.getById(sessionId);
  assert.equal(session?.model, "claude-opus-4-7", "model should be backfilled from assistant event");
  console.log("[smoke] phase 2 ok — assistant text + Read tool tracked artifact touch");

  // ── Phase 3: tool_result wrapped in user-typed event maps to tool_result ──
  const toolResultEvent = {
    type: "user",
    sessionId,
    cwd: fakeCwd,
    timestamp: "2026-04-28T12:00:06.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu1", content: "# hi" }],
    },
  };
  appendFileSync(jsonlPath, JSON.stringify(toolResultEvent) + "\n");
  await sleep(500);

  const allEvents = sessionStore.getEventsBySession(sessionId);
  const toolResult = allEvents.find((e) => e.role === "tool_result");
  assert(toolResult, "tool_result event should be inserted");
  assert(/# hi/.test(toolResult.text));
  console.log("[smoke] phase 3 ok — tool_result event tagged with tool_result role");

  // ── Phase 4: orphan session (no matching source) lands with space_id=null ──
  const orphanCwd = "/tmp/some-unregistered-place";
  const orphanProjectDir = join(projectsRoot, "-tmp-some-unregistered-place");
  mkdirSync(orphanProjectDir, { recursive: true });
  const orphanId = "00000000-aaaa-bbbb-cccc-222222222222";
  const orphanPath = join(orphanProjectDir, `${orphanId}.jsonl`);
  writeFileSync(orphanPath, JSON.stringify({
    type: "user",
    sessionId: orphanId,
    cwd: orphanCwd,
    timestamp: "2026-04-28T12:01:00.000Z",
    message: { role: "user", content: "hello from nowhere" },
  }) + "\n");
  await sleep(800);

  const orphan = sessionStore.getById(orphanId);
  assert(orphan, "orphan session should still be inserted");
  assert.equal(orphan.space_id, null, "orphan session should have null space_id");
  console.log("[smoke] phase 4 ok — orphan session has null space_id");

  // ── Cleanup ──
  await watcher.stop();
  db.close();
  rmSync(root, { recursive: true, force: true });

  console.log("\n[smoke] ALL PHASES PASSED ✓");
}

run().catch((err) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
