import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

describe("sessions table — status-evidence columns", () => {
  it("has exit_code, exit_signal, explicit_exit_seen, clean_process_exit, last_assistant_stop_reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "oyster-test-"));
    const db = initDb(dir);
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
    const dir = mkdtempSync(join(tmpdir(), "oyster-test-"));
    const db = initDb(dir);
    expect(() =>
      db.prepare(`
        INSERT INTO sessions (id, agent, title, state)
        VALUES ('s1', 'claude-code', 't', 'dormant')
      `).run(),
    ).toThrow(/CHECK constraint/);
  });
});
