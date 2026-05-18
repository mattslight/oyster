// Smoke tests for the multi-instance ClaudePtyManager. Each test spawns a
// trivial shell (sh / sleep) — not `claude` itself — to exercise the
// lifecycle without depending on Claude Code being installed in CI.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ClaudePtyManager, TerminalCapError, PtyUnavailableError } from "../src/claude-pty-manager.js";
import { tmpdir, homedir } from "node:os";

const SLEEP = process.platform === "win32" ? "ping" : "sleep";
const SLEEP_ARGS = process.platform === "win32"
  ? ["-n", "60", "127.0.0.1"]
  : ["60"];

describe("ClaudePtyManager", () => {
  let mgr: ClaudePtyManager;

  beforeEach(() => {
    mgr = new ClaudePtyManager();
  });
  afterEach(() => {
    mgr.disposeAll();
  });

  it("spawn returns an entry visible to list()", () => {
    if (!mgr.isPtyAvailable()) return; // CI without node-pty: skip
    const { terminalId } = mgr.spawn({
      kind: "claude_new",
      command: SLEEP,
      args: SLEEP_ARGS,
      cwd: tmpdir(),
      env: { HOME: homedir(), PATH: process.env.PATH ?? "" },
    });
    const list = mgr.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.terminalId).toBe(terminalId);
    expect(list[0]!.alive).toBe(true);
    expect(list[0]!.linkedSessionId).toBeNull();
  });

  it("setLinkedSession updates the entry's linkedSessionId", () => {
    if (!mgr.isPtyAvailable()) return;
    const { terminalId } = mgr.spawn({
      kind: "claude_resume",
      command: SLEEP,
      args: SLEEP_ARGS,
      cwd: tmpdir(),
      env: { HOME: homedir(), PATH: process.env.PATH ?? "" },
    });
    expect(mgr.setLinkedSession(terminalId, "session-uuid")).toBe(true);
    const list = mgr.list();
    expect(list[0]!.linkedSessionId).toBe("session-uuid");
  });

  it("rejects more than 8 concurrent terminals with TerminalCapError", () => {
    if (!mgr.isPtyAvailable()) return;
    for (let i = 0; i < 8; i++) {
      mgr.spawn({
        kind: "claude_new",
        command: SLEEP,
        args: SLEEP_ARGS,
        cwd: tmpdir(),
        env: { HOME: homedir(), PATH: process.env.PATH ?? "" },
      });
    }
    expect(() => mgr.spawn({
      kind: "claude_new",
      command: SLEEP,
      args: SLEEP_ARGS,
      cwd: tmpdir(),
      env: { HOME: homedir(), PATH: process.env.PATH ?? "" },
    })).toThrow(TerminalCapError);
  });

  it("kill() retires the entry from list() after disposeAll", () => {
    if (!mgr.isPtyAvailable()) return;
    const { terminalId } = mgr.spawn({
      kind: "claude_new",
      command: SLEEP,
      args: SLEEP_ARGS,
      cwd: tmpdir(),
      env: { HOME: homedir(), PATH: process.env.PATH ?? "" },
    });
    expect(mgr.kill(terminalId)).toBe(true);
    mgr.disposeAll();
    expect(mgr.list()).toHaveLength(0);
  });

  it("reaps a zombie entry whose process has died on next spawn", async () => {
    if (!mgr.isPtyAvailable()) return;
    // Spawn one terminal, kill its OS process out-of-band, then null out
    // the entry's exitedAt to simulate the case where `proc.onExit` never
    // fired (native error, hard kill before pty wiring, etc.). Next spawn
    // should reap the zombie before counting against the cap.
    const first = mgr.spawn({
      kind: "claude_new",
      command: SLEEP,
      args: SLEEP_ARGS,
      cwd: tmpdir(),
      env: { HOME: homedir(), PATH: process.env.PATH ?? "" },
    });
    const entry = mgr.getEntry(first.terminalId)!;
    process.kill(entry.proc.pid, "SIGKILL");
    // Give the kernel a beat to actually reap the process so the next
    // `process.kill(pid, 0)` probe sees ESRCH.
    await new Promise((r) => setTimeout(r, 150));

    // Pretend onExit never fired.
    if (entry.evictTimer) { clearTimeout(entry.evictTimer); entry.evictTimer = null; }
    entry.exitedAt = null;

    const second = mgr.spawn({
      kind: "claude_new",
      command: SLEEP,
      args: SLEEP_ARGS,
      cwd: tmpdir(),
      env: { HOME: homedir(), PATH: process.env.PATH ?? "" },
    });
    expect(second.terminalId).not.toBe(first.terminalId);
    expect(mgr.getEntry(first.terminalId)?.exitedAt).not.toBeNull();
  });

  it("setLinkedSession returns false for unknown id", () => {
    expect(mgr.setLinkedSession("nope", "x")).toBe(false);
  });

  it("kill() returns false for unknown id", () => {
    expect(mgr.kill("nope")).toBe(false);
  });

  // Documents what happens on a host where node-pty failed to load —
  // spawn must throw PtyUnavailableError rather than producing a half-
  // initialised entry.
  it("throws PtyUnavailableError if pty isn't available", () => {
    if (mgr.isPtyAvailable()) return;
    expect(() => mgr.spawn({
      kind: "claude_new",
      command: SLEEP,
      args: SLEEP_ARGS,
      cwd: tmpdir(),
      env: {},
    })).toThrow(PtyUnavailableError);
  });
});
