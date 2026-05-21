import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";

function seed(store: SqliteSessionStore, id: string) {
  store.insertSession({
    id, space_id: null, agent: "claude-code", state: "active",
  });
}

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "oyster-exit-info-"));
  const db = initDb(dir);
  const store = new SqliteSessionStore(db);
  return {
    db, store,
    dispose: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe("SessionStore — exit info + last_assistant_stop_reason", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.dispose(); });

  it("recordExit writes exit_code, exit_signal, clean_process_exit", () => {
    seed(env.store, "s1");
    env.store.recordExit("s1", { exitCode: 0, exitSignal: null, cleanProcessExit: true });
    const row = env.db.prepare(
      "SELECT exit_code, exit_signal, clean_process_exit FROM sessions WHERE id=?"
    ).get("s1");
    expect(row).toEqual({ exit_code: 0, exit_signal: null, clean_process_exit: 1 });
  });

  it("recordExit on bad exit does not set clean_process_exit", () => {
    seed(env.store, "s1");
    env.store.recordExit("s1", { exitCode: 137, exitSignal: "SIGKILL", cleanProcessExit: false });
    const row = env.db.prepare(
      "SELECT exit_code, exit_signal, clean_process_exit FROM sessions WHERE id=?"
    ).get("s1");
    expect(row).toEqual({ exit_code: 137, exit_signal: "SIGKILL", clean_process_exit: 0 });
  });

  it("setLastAssistantStopReason updates only that column", () => {
    seed(env.store, "s1");
    env.store.setLastAssistantStopReason("s1", "end_turn");
    const row = env.db.prepare(
      "SELECT last_assistant_stop_reason FROM sessions WHERE id=?"
    ).get("s1");
    expect(row).toEqual({ last_assistant_stop_reason: "end_turn" });
  });

  it("markExplicitExitSeen flips the flag without touching process-exit fields", () => {
    seed(env.store, "s1");
    env.store.markExplicitExitSeen("s1");
    const row = env.db.prepare(
      "SELECT explicit_exit_seen, exit_code, exit_signal, clean_process_exit FROM sessions WHERE id=?"
    ).get("s1");
    expect(row).toEqual({
      explicit_exit_seen: 1, exit_code: null, exit_signal: null, clean_process_exit: 0,
    });
  });
});
