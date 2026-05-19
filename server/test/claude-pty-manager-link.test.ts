import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { ClaudePtyManager } from "../src/claude-pty-manager.js";

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "oyster-pty-link-"));
  const db = initDb(dir);
  const store = new SqliteSessionStore(db);
  const events: { command: string; payload: unknown }[] = [];
  const broadcast = (cmd: { command: string; payload: unknown }) => { events.push(cmd); };
  const mgr = new ClaudePtyManager({ sessionStore: store, broadcastUiEvent: broadcast });
  store.insertSession({ id: "s1", space_id: null, agent: "claude-code", state: "done" });
  return {
    db, store, mgr, events,
    dispose: () => { mgr.disposeAll(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe("ClaudePtyManager DB link", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.dispose(); });

  it("setLinkedSession writes terminal_id to the linked session row", () => {
    env.mgr._seedEntryForTest({ terminalId: "t1", linkedSessionId: null });
    env.mgr.setLinkedSession("t1", "s1");
    const row = env.store.getById("s1")!;
    expect(row.terminal_id).toBe("t1");
  });

  it("calling kill() clears terminal_id on the linked session row", () => {
    env.mgr._seedEntryForTest({ terminalId: "t2", linkedSessionId: null });
    env.mgr.setLinkedSession("t2", "s1");
    env.mgr.kill("t2");
    // proc.onExit is what actually clears the row; the test seed wires a
    // synchronous fake proc that fires onExit during kill().
    const row = env.store.getById("s1")!;
    expect(row.terminal_id).toBeNull();
    expect(row.terminal_attached_clients).toBe(0);
  });
});
