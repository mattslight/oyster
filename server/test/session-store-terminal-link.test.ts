import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";

function seed(store: SqliteSessionStore, id: string) {
  store.insertSession({
    id, space_id: null, agent: "claude-code", state: "done",
  });
}

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "oyster-term-link-"));
  const db = initDb(dir);
  const store = new SqliteSessionStore(db);
  return {
    db, store,
    dispose: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe("SqliteSessionStore terminal link", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.dispose(); });

  it("linkTerminal writes terminal_id, clearTerminal nulls it and resets clients", () => {
    seed(env.store, "s1");
    env.store.linkTerminal("s1", "term-1");
    env.store.setAttachedClients("s1", 2);
    const row = env.store.getById("s1")!;
    expect(row.terminal_id).toBe("term-1");
    expect(row.terminal_attached_clients).toBe(2);

    env.store.clearTerminal("s1");
    const cleared = env.store.getById("s1")!;
    expect(cleared.terminal_id).toBeNull();
    expect(cleared.terminal_attached_clients).toBe(0);
  });

  it("setAttachedClients on an unknown session is a no-op (does not throw)", () => {
    expect(() => env.store.setAttachedClients("missing", 1)).not.toThrow();
  });
});
