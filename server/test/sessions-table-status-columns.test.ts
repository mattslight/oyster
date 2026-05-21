import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initDb } from "../src/db.js";

describe("sessions table — status-evidence columns", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oyster-test-"));
    db = initDb(dir);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("has exit_code, exit_signal, explicit_exit_seen, clean_process_exit, last_assistant_stop_reason", () => {
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
      name: string; notnull: number; dflt_value: unknown;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.has("exit_code")).toBe(true);
    expect(byName.has("exit_signal")).toBe(true);
    expect(byName.has("explicit_exit_seen")).toBe(true);
    expect(byName.has("clean_process_exit")).toBe(true);
    expect(byName.has("last_assistant_stop_reason")).toBe(true);

    // Lock in the structural shape — typos like DEAFULT or NULL slip through column-name-only checks.
    expect(byName.get("explicit_exit_seen")).toMatchObject({ notnull: 1, dflt_value: "0" });
    expect(byName.get("clean_process_exit")).toMatchObject({ notnull: 1, dflt_value: "0" });
  });

  it("still rejects 'dormant' as a stored state value (dormant is display-only)", () => {
    expect(() =>
      db.prepare(`
        INSERT INTO sessions (id, agent, title, state)
        VALUES ('s1', 'claude-code', 't', 'dormant')
      `).run(),
    ).toThrow(/CHECK constraint/);
  });
});
