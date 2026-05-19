import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "oyster-term-cols-"));
  return {
    dir,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("sessions table — terminal columns", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.dispose(); });

  it("adds terminal_id and terminal_attached_clients columns idempotently", () => {
    const db1 = initDb(env.dir);
    const cols = db1.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    const names = cols.map(c => c.name);
    expect(names).toContain("terminal_id");
    expect(names).toContain("terminal_attached_clients");
    db1.close();

    // Re-init — must not throw on duplicate-column ALTER.
    const db2 = initDb(env.dir);
    db2.close();
  });

  it("boot reset clears stale terminal_id and zeros attached clients", () => {
    const db1 = initDb(env.dir);
    db1.prepare(
      `INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('s','s','#000','none')`,
    ).run();
    db1.prepare(
      `INSERT INTO sessions
         (id, space_id, cwd, agent, title, state, started_at, last_event_at,
          terminal_id, terminal_attached_clients)
       VALUES
         ('a', 's', NULL, 'claude-code', 't', 'done',
          '2026-05-19T10:00:00Z', '2026-05-19T10:30:00Z',
          'stale-term-id', 3)`,
    ).run();
    db1.close();

    // Re-init — boot reset should fire.
    const db2 = initDb(env.dir);
    const row = db2.prepare(
      "SELECT terminal_id, terminal_attached_clients FROM sessions WHERE id = 'a'",
    ).get() as { terminal_id: string | null; terminal_attached_clients: number };
    expect(row.terminal_id).toBeNull();
    expect(row.terminal_attached_clients).toBe(0);
    db2.close();
  });
});
