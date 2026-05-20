import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { ClaudePtyManager, POST_EXIT_RETENTION_MS, MAX_RETAINED_EXITED } from "../src/claude-pty-manager.js";

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "oyster-pty-cap-"));
  const db = initDb(dir);
  const store = new SqliteSessionStore(db);
  const mgr = new ClaudePtyManager({ sessionStore: store, broadcastUiEvent: () => {} });
  return { db, store, mgr, dispose: () => { mgr.disposeAll(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("ClaudePtyManager retention", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.dispose(); });

  it("POST_EXIT_RETENTION_MS is 15 minutes", () => {
    expect(POST_EXIT_RETENTION_MS).toBe(15 * 60 * 1000);
  });

  it("MAX_RETAINED_EXITED is 50", () => {
    expect(MAX_RETAINED_EXITED).toBe(50);
  });

  it("evicts the oldest exited entry when the cap is exceeded", () => {
    // Seed MAX_RETAINED_EXITED + 1 exited entries, oldest first.
    for (let i = 0; i < MAX_RETAINED_EXITED + 1; i++) {
      env.mgr._seedEntryForTest({ terminalId: `t${i}`, linkedSessionId: null });
      env.mgr.kill(`t${i}`); // marks exited via the fake proc's onExit
    }
    expect(env.mgr.list().length).toBe(MAX_RETAINED_EXITED);
    expect(env.mgr.getEntry("t0")).toBeUndefined(); // oldest evicted
    expect(env.mgr.getEntry(`t${MAX_RETAINED_EXITED}`)).toBeDefined(); // newest kept
  });
});
