import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { mapSessionRow } from "../src/routes/sessions.js";

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "oyster-sess-route-term-"));
  const db = initDb(dir);
  const store = new SqliteSessionStore(db);
  return { db, store, dispose: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("GET /api/sessions payload — terminal fields", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.dispose(); });

  it("payload mapping projects terminal_id and terminal_attached_clients", () => {
    env.store.insertSession({ id: "s1", space_id: null, agent: "claude-code", state: "done" });
    env.store.linkTerminal("s1", "term-1");
    env.store.setAttachedClients("s1", 2);

    const row = env.store.getById("s1")!;
    const payload = mapSessionRow(row, /* myDeviceId */ null, /* myDeviceLabel */ null);
    expect(payload.terminalId).toBe("term-1");
    expect(payload.terminalAttachedClients).toBe(2);
  });

  it("payload mapping projects null/0 when no terminal linked", () => {
    env.store.insertSession({ id: "s2", space_id: null, agent: "claude-code", state: "done" });
    const row = env.store.getById("s2")!;
    const payload = mapSessionRow(row, null, null);
    expect(payload.terminalId).toBeNull();
    expect(payload.terminalAttachedClients).toBe(0);
  });
});
