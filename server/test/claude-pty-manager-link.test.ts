import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { ClaudePtyManager } from "../src/claude-pty-manager.js";
import { WebSocket } from "ws";

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "oyster-pty-link-"));
  const db = initDb(dir);
  const store = new SqliteSessionStore(db);
  const events: { command: string; payload: unknown }[] = [];
  const broadcast = (cmd: { command: string; payload: unknown }) => { events.push(cmd); };
  const mgr = new ClaudePtyManager({ sessionStore: store, db, broadcastUiEvent: broadcast });
  store.insertSession({ id: "s1", space_id: null, agent: "claude-code", state: "done" });
  return {
    db, store, mgr, events,
    dispose: () => { mgr.disposeAll(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe("ClaudePtyManager attached clients", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.dispose(); });

  it("emits terminal:attached / terminal:detached / terminal:exited", () => {
    env.mgr._seedEntryForTest({ terminalId: "t1", linkedSessionId: null });
    env.mgr.linkTerminalForTest("t1", "s1");
    env.events.length = 0;

    const ws = makeFakeWs();
    env.mgr.attachClient("t1", ws as unknown as WebSocket);
    ws.fireClose();
    env.mgr.kill("t1");

    const commands = env.events.map(e => e.command);
    expect(commands).toContain("terminal:attached");
    expect(commands).toContain("terminal:detached");
    expect(commands).toContain("terminal:exited");

    const attachedEvent = env.events.find(e => e.command === "terminal:attached")!;
    const payload = attachedEvent.payload as { terminalId: string; sessionId: string | null; attachedClients: number };
    expect(payload.terminalId).toBe("t1");
    expect(payload.sessionId).toBe("s1");
    expect(payload.attachedClients).toBe(1);
  });

  it("attach/detach updates terminal_attached_clients on the linked row", () => {
    env.mgr._seedEntryForTest({ terminalId: "t1", linkedSessionId: "s1" });
    env.mgr.linkTerminalForTest("t1", "s1");

    const fakeWs1 = makeFakeWs();
    const fakeWs2 = makeFakeWs();

    env.mgr.attachClient("t1", fakeWs1 as unknown as WebSocket);
    expect(env.store.getById("s1")!.terminal_attached_clients).toBe(1);

    env.mgr.attachClient("t1", fakeWs2 as unknown as WebSocket);
    expect(env.store.getById("s1")!.terminal_attached_clients).toBe(2);

    fakeWs1.fireClose();
    expect(env.store.getById("s1")!.terminal_attached_clients).toBe(1);

    fakeWs2.fireClose();
    expect(env.store.getById("s1")!.terminal_attached_clients).toBe(0);
  });

  it("attach after PTY exit does NOT update terminal_attached_clients", () => {
    // Give s1 a real event so it is not a ghost and won't be deleted on exit.
    env.store.insertEvent({ session_id: "s1", role: "user", text: "hello" });
    env.mgr._seedEntryForTest({ terminalId: "t1", linkedSessionId: null });
    env.mgr.linkTerminalForTest("t1", "s1");
    // Kill the PTY — fires _handleExit synchronously via the fake proc.
    env.mgr.kill("t1");
    // terminal_attached_clients should be 0 after exit (clearTerminal resets it).
    expect(env.store.getById("s1")!.terminal_attached_clients).toBe(0);
    env.events.length = 0;

    // Now attach a new WS to the retained (exited) entry.
    const ws = makeFakeWs();
    env.mgr.attachClient("t1", ws as unknown as WebSocket);

    // DB count must remain 0 — no write for an exited terminal.
    expect(env.store.getById("s1")!.terminal_attached_clients).toBe(0);
    // No terminal:attached event should be emitted.
    expect(env.events.map(e => e.command)).not.toContain("terminal:attached");
  });

  it("ws close after PTY exit does NOT update terminal_attached_clients", () => {
    // Give s1 a real event so it is not a ghost and won't be deleted on exit.
    env.store.insertEvent({ session_id: "s1", role: "user", text: "hello" });
    env.mgr._seedEntryForTest({ terminalId: "t1", linkedSessionId: null });
    env.mgr.linkTerminalForTest("t1", "s1");

    // Attach a WS while the PTY is still alive.
    const ws = makeFakeWs();
    env.mgr.attachClient("t1", ws as unknown as WebSocket);
    expect(env.store.getById("s1")!.terminal_attached_clients).toBe(1);

    // Kill the PTY — fires _handleExit synchronously.
    env.mgr.kill("t1");
    // clearTerminal resets attached_clients to 0.
    expect(env.store.getById("s1")!.terminal_attached_clients).toBe(0);
    env.events.length = 0;

    // Now close the WS — the close handler should be gated on exitedAt.
    ws.fireClose();

    // DB count must remain 0 — no write after exit.
    expect(env.store.getById("s1")!.terminal_attached_clients).toBe(0);
    // No terminal:detached event should be emitted.
    expect(env.events.map(e => e.command)).not.toContain("terminal:detached");
  });
});

function makeFakeWs() {
  const handlers: Record<string, ((arg?: unknown) => void)[]> = { message: [], close: [] };
  return {
    readyState: 1, // OPEN
    send: () => {},
    on(event: string, cb: (arg?: unknown) => void) { handlers[event] ??= []; handlers[event].push(cb); },
    fireClose() { handlers.close?.forEach(cb => cb()); },
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
    // Give s1 a real event so it is not a ghost and won't be deleted on exit.
    env.store.insertEvent({ session_id: "s1", role: "user", text: "hello" });
    env.mgr._seedEntryForTest({ terminalId: "t2", linkedSessionId: null });
    env.mgr.setLinkedSession("t2", "s1");
    env.mgr.kill("t2");
    // proc.onExit is what actually clears the row; the test seed wires a
    // synchronous fake proc that fires onExit during kill().
    const row = env.store.getById("s1")!;
    expect(row.terminal_id).toBeNull();
    expect(row.terminal_attached_clients).toBe(0);
  });

  it("calling kill() marks the linked session done on a clean exit", () => {
    // Give s1 a real event so it is not a ghost and won't be deleted on exit.
    env.store.insertEvent({ session_id: "s1", role: "user", text: "hello" });
    env.mgr._seedEntryForTest({ terminalId: "t3", linkedSessionId: null });
    env.mgr.setLinkedSession("t3", "s1");
    // Seed row state to "active" so we can verify the transition.
    env.store.updateSessionState("s1", "active", new Date().toISOString());
    expect(env.store.getById("s1")!.state).toBe("active");

    env.mgr.kill("t3");

    // The fake proc fires {exitCode: 0, signal: null} → clean process exit
    // → transient state should be "done". The next heartbeat sweep will
    // re-derive from the recorded facts.
    expect(env.store.getById("s1")!.state).toBe("done");
  });

  it("calling kill() deletes a ghost session (no events, no JSONL)", () => {
    // s1 was inserted in makeEnv but has no events — a ghost.
    env.mgr._seedEntryForTest({ terminalId: "t4", linkedSessionId: null });
    env.mgr.setLinkedSession("t4", "s1");
    expect(env.store.getById("s1")).toBeDefined();

    env.mgr.kill("t4");

    // Ghost row should be deleted entirely.
    expect(env.store.getById("s1")).toBeUndefined();
  });
});
