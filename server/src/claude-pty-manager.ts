// Multi-instance PTY manager dedicated to Claude Code launches.
//
// Distinct from `pty-manager.ts` (the legacy OpenCode singleton): each Claude
// terminal has its own `proc`, scrollback, and connected-clients set, keyed
// by a generated `terminalId`. WebSockets attach at `/ws/terminal?id=<id>`
// and the upgrade is routed to us explicitly by `index.ts`.
//
// On `proc.onExit` we retain the entry for 30s so a transient WS reconnect
// can still replay the final frames before we drop scrollback.

import { randomUUID } from "node:crypto";
import { constants as osConstants } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type Database from "better-sqlite3";
import type { SessionStore } from "./session-store.js";
import type { UiCommand, TerminalPresenceEventPayload } from "../../shared/types.js";
import { deleteIfGhostOnExit } from "./ghost-session-cleanup.js";

// node-pty's `onExit` reports `signal` as a number (POSIX signal int) per its
// type declaration. We translate to the conventional `SIGxxx` name at the
// capture boundary so `exit_signal` is human-readable in the DB and any UI
// tooltips downstream. Tests may pass names directly — passthrough is
// intentional so test fixtures don't need to remember signal numbers.
const SIGNAL_NUMBER_TO_NAME: ReadonlyMap<number, string> = (() => {
  const m = new Map<number, string>();
  for (const [name, num] of Object.entries(osConstants.signals)) {
    if (typeof num === "number" && !m.has(num)) m.set(num, name);
  }
  return m;
})();

export function signalName(signal: number | string | null | undefined): string | null {
  if (signal == null) return null;
  if (typeof signal === "string") return signal;
  return SIGNAL_NUMBER_TO_NAME.get(signal) ?? `signal-${signal}`;
}

export interface ClaudePtyManagerDeps {
  sessionStore: SessionStore;
  db: Database.Database;
  broadcastUiEvent: (cmd: UiCommand) => void;
}

const SCROLLBACK_LIMIT = 50_000;
export const POST_EXIT_RETENTION_MS = 15 * 60 * 1000;
export const MAX_RETAINED_EXITED = 50;
const MAX_CONCURRENT_TERMINALS = 8;

export class TerminalCapError extends Error {
  constructor() {
    super("too_many_terminals");
    this.name = "TerminalCapError";
  }
}

export class PtyUnavailableError extends Error {
  constructor() {
    super("pty_unavailable");
    this.name = "PtyUnavailableError";
  }
}

export interface ClaudePtyEntry {
  terminalId: string;
  kind: "claude_new" | "claude_resume";
  proc: any;
  scrollback: string;
  clients: Set<WebSocket>;
  cwd: string;
  command: string;
  args: string[];
  startedAt: number;
  exitedAt: number | null;
  linkedSessionId: string | null;
  evictTimer: NodeJS.Timeout | null;
}

export interface SpawnInput {
  kind: "claude_new" | "claude_resume";
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface SpawnResult {
  terminalId: string;
  startedAt: number;
}

// Mirror of pty-manager.ts's dynamic import. Duplicated rather than extracted
// to keep blast radius tiny in the v1 rollout.
let ptyModule: any = null;
let ptyAvailable = false;
async function loadPty(): Promise<void> {
  if (ptyAvailable || ptyModule) return;
  try {
    ptyModule = await import("@lydell/node-pty");
    ptyAvailable = true;
  } catch {
    try {
      // @ts-ignore — fallback, may not be installed
      ptyModule = await import("node-pty");
      ptyAvailable = true;
    } catch {
      ptyAvailable = false;
    }
  }
}
// Eagerly attempt — module is cheap to load and a missing native binding
// should surface at boot, not at first user click.
loadPty().catch(() => { /* swallowed; spawn throws PtyUnavailableError instead */ });

export interface ClaudePtyListEntry {
  terminalId: string;
  kind: "claude_new" | "claude_resume";
  cwd: string;
  command: string;
  args: string[];
  startedAt: number;
  linkedSessionId: string | null;
  alive: boolean;
}

export class ClaudePtyManager {
  private terminals = new Map<string, ClaudePtyEntry>();
  private wss = new WebSocketServer({ noServer: true });
  private sessionStore: SessionStore;
  private db: Database.Database;
  private broadcastUiEvent: (cmd: UiCommand) => void;

  constructor(deps: ClaudePtyManagerDeps) {
    this.sessionStore = deps.sessionStore;
    this.db = deps.db;
    this.broadcastUiEvent = deps.broadcastUiEvent;
  }

  spawn(input: SpawnInput): SpawnResult {
    if (!ptyAvailable || !ptyModule) {
      throw new PtyUnavailableError();
    }
    // Reap zombie entries before counting. node-pty's `onExit` doesn't
    // strictly guarantee firing on every failure path (native errors during
    // spawn, hard kills before the pty is fully wired, etc.). Without this,
    // a zombie can occupy a slot against the cap forever. `process.kill(pid, 0)`
    // is the standard probe — throws ESRCH when the process is gone.
    for (const entry of this.terminals.values()) {
      if (entry.exitedAt !== null) continue;
      const pid = entry.proc?.pid;
      if (typeof pid !== "number") continue;
      try {
        process.kill(pid, 0);
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === "ESRCH") {
          // Process is gone; mark exited so it stops counting against the
          // cap. Schedule the same 30s retention so reconnects still see
          // the final scrollback.
          entry.exitedAt = Date.now();
          entry.evictTimer ??= setTimeout(() => {
            this.terminals.delete(entry.terminalId);
          }, POST_EXIT_RETENTION_MS);
        }
        // EPERM means it exists but we can't signal it — leave as alive.
      }
    }
    const alive = Array.from(this.terminals.values()).filter((t) => t.exitedAt === null).length;
    if (alive >= MAX_CONCURRENT_TERMINALS) {
      throw new TerminalCapError();
    }

    const terminalId = randomUUID();
    const startedAt = Date.now();
    const pty = ptyModule.default ?? ptyModule;
    const proc = pty.spawn(input.command, input.args, {
      name: "xterm-256color",
      cols: input.cols ?? 120,
      rows: input.rows ?? 40,
      cwd: input.cwd,
      env: input.env,
    });

    const entry: ClaudePtyEntry = {
      terminalId,
      kind: input.kind,
      proc,
      scrollback: "",
      clients: new Set(),
      cwd: input.cwd,
      command: input.command,
      args: input.args,
      startedAt,
      exitedAt: null,
      linkedSessionId: null,
      evictTimer: null,
    };
    this.terminals.set(terminalId, entry);

    proc.onData((data: string) => {
      entry.scrollback += data;
      if (entry.scrollback.length > SCROLLBACK_LIMIT) {
        entry.scrollback = entry.scrollback.slice(-SCROLLBACK_LIMIT);
      }
      for (const ws of entry.clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      }
    });

    proc.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      this._handleExit(entry, { exitCode, signal: signalName(signal) });
    });

    return { terminalId, startedAt };
  }

  attachClient(terminalId: string, ws: WebSocket): boolean {
    const entry = this.terminals.get(terminalId);
    if (!entry) return false;
    entry.clients.add(ws);
    if (entry.exitedAt === null && entry.linkedSessionId) {
      this.sessionStore.setAttachedClients(entry.linkedSessionId, entry.clients.size);
      this.broadcastUiEvent({
        version: 1,
        command: "terminal:attached",
        payload: { terminalId, sessionId: entry.linkedSessionId, attachedClients: entry.clients.size } satisfies TerminalPresenceEventPayload,
      });
      this.notifySessionChanged(entry.linkedSessionId);
    }

    if (entry.scrollback.length > 0) {
      ws.send(entry.scrollback);
    }

    ws.on("message", (msg: Buffer | string) => {
      if (entry.exitedAt !== null) return;
      const data = typeof msg === "string" ? msg : msg.toString("utf-8");
      // JSON control envelope for resize. Tolerant: malformed JSON or
      // unknown types pass through as input bytes.
      if (data.length > 0 && data.charCodeAt(0) === 0x7b /* `{` */) {
        try {
          const ctrl = JSON.parse(data);
          if (ctrl && ctrl.type === "resize" && Number.isInteger(ctrl.cols) && Number.isInteger(ctrl.rows)) {
            if (ctrl.cols > 0 && ctrl.rows > 0) entry.proc.resize(ctrl.cols, ctrl.rows);
            return;
          }
        } catch { /* fall through */ }
      }
      entry.proc.write(data);
    });

    ws.on("close", () => {
      entry.clients.delete(ws);
      if (entry.exitedAt === null && entry.linkedSessionId) {
        this.sessionStore.setAttachedClients(entry.linkedSessionId, entry.clients.size);
        this.broadcastUiEvent({
          version: 1,
          command: "terminal:detached",
          payload: { terminalId, sessionId: entry.linkedSessionId, attachedClients: entry.clients.size } satisfies TerminalPresenceEventPayload,
        });
        this.notifySessionChanged(entry.linkedSessionId);
      }
    });

    return true;
  }

  setLinkedSession(terminalId: string, sessionId: string): boolean {
    const entry = this.terminals.get(terminalId);
    if (!entry) return false;
    entry.linkedSessionId = sessionId;
    this.sessionStore.linkTerminal(sessionId, terminalId);
    return true;
  }

  /**
   * Kill the PTY child. `reason` distinguishes a user-driven stop (UI
   * red-square click) from system-driven kills (e.g. disposeAll on
   * server shutdown). When `'user_stop'`, the linked session's
   * `user_stop_requested_at` is stamped *before* the signal is sent so
   * the eventual signal-driven exit is classified as a clean
   * shutdown, not a crash. The flag must precede the signal — once
   * `proc.kill()` runs, the exit handler can race ahead and call
   * `recordExit`, and by then `deriveState` must already see the
   * intent.
   */
  kill(terminalId: string, opts: { reason?: "user_stop" | "system" } = {}): boolean {
    const entry = this.terminals.get(terminalId);
    if (!entry) return false;
    if (opts.reason === "user_stop" && entry.linkedSessionId) {
      this.sessionStore.markUserStopRequested(entry.linkedSessionId);
    }
    try { entry.proc.kill(); } catch { /* best-effort */ }
    // proc.onExit fans out closeNote + schedules eviction. Drop the entry
    // immediately if the proc had already exited (defensive).
    if (entry.exitedAt !== null && !entry.evictTimer) {
      this.terminals.delete(terminalId);
    }
    return true;
  }

  list(): ClaudePtyListEntry[] {
    return Array.from(this.terminals.values()).map((e) => ({
      terminalId: e.terminalId,
      kind: e.kind,
      cwd: e.cwd,
      command: e.command,
      args: e.args.slice(),
      startedAt: e.startedAt,
      linkedSessionId: e.linkedSessionId,
      alive: e.exitedAt === null,
    }));
  }

  getEntry(terminalId: string): ClaudePtyEntry | undefined {
    return this.terminals.get(terminalId);
  }

  disposeAll(): void {
    for (const entry of this.terminals.values()) {
      if (entry.evictTimer) {
        clearTimeout(entry.evictTimer);
        entry.evictTimer = null;
      }
      try { entry.proc.kill(); } catch { /* best-effort */ }
    }
    this.terminals.clear();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, terminalId: string): void {
    const entry = this.terminals.get(terminalId);
    if (!entry) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.attachClient(terminalId, ws);
    });
  }

  isPtyAvailable(): boolean {
    return ptyAvailable;
  }

  private notifySessionChanged(sessionId: string | null): void {
    if (!sessionId) return;
    this.broadcastUiEvent({ version: 1, command: "session_changed", payload: { id: sessionId } });
  }

  private enforceRetentionCap(): void {
    const exited = Array.from(this.terminals.values())
      .filter(e => e.exitedAt !== null)
      .sort((a, b) => (a.exitedAt ?? 0) - (b.exitedAt ?? 0));
    while (exited.length > MAX_RETAINED_EXITED) {
      const victim = exited.shift()!;
      if (victim.evictTimer) { clearTimeout(victim.evictTimer); victim.evictTimer = null; }
      this.terminals.delete(victim.terminalId);
    }
  }

  private _handleExit(entry: ClaudePtyEntry, exit: { exitCode: number; signal: string | null }): void {
    entry.exitedAt = Date.now();
    const closeNote = `\r\n\x1b[90m[session ended (exit ${exit.exitCode})]\x1b[0m\r\n`;
    entry.scrollback += closeNote;
    for (const ws of entry.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(closeNote);
    }
    const exitedSessionId = entry.linkedSessionId;
    if (exitedSessionId) {
      // Clear the terminal link first so the row no longer claims a
      // live PTY no matter which branch below runs.
      this.sessionStore.clearTerminal(exitedSessionId);
      // If the session never produced content (no events AND no JSONL
      // file), the stub row inserted at spawn time is a ghost — drop it
      // entirely rather than leaving an un-resumable "Untitled"
      // entry in the list. Otherwise, record the exit facts and write a
      // transient state so SSE clients see the result of this exit
      // immediately. The next heartbeat sweep will re-derive from facts —
      // Task 5 will teach deriveState to read exit_code/exit_signal/
      // clean_process_exit so this value sticks. Until then, an in-flight
      // session may briefly re-derive to "active" if it exited within the
      // active-window.
      const deleted = deleteIfGhostOnExit(this.sessionStore, this.db, exitedSessionId, entry.cwd);
      if (!deleted) {
        const cleanProcessExit = exit.exitCode === 0 && !exit.signal;
        this.sessionStore.recordExit(exitedSessionId, {
          exitCode: exit.exitCode,
          exitSignal: exit.signal ?? null,
          cleanProcessExit,
        });
        this.sessionStore.updateSessionState(
          exitedSessionId,
          cleanProcessExit ? "done" : "disconnected",
          new Date().toISOString(),
        );
      }
      entry.linkedSessionId = null;
    }
    this.broadcastUiEvent({
      version: 1,
      command: "terminal:exited",
      payload: { terminalId: entry.terminalId, sessionId: exitedSessionId, attachedClients: 0 } satisfies TerminalPresenceEventPayload,
    });
    this.notifySessionChanged(exitedSessionId);
    // Retain for late reconnects, then evict.
    entry.evictTimer = setTimeout(() => {
      this.terminals.delete(entry.terminalId);
    }, POST_EXIT_RETENTION_MS);
    // Eagerly enforce the hard cap, evicting oldest-exited-first.
    this.enforceRetentionCap();
  }

  /** Test-only: pair `_seedEntryForTest` with a link write in one step. */
  linkTerminalForTest(terminalId: string, sessionId: string): void { this.setLinkedSession(terminalId, sessionId); }

  /** Test-only: inject a fake entry with a stub proc whose onExit fires
   *  immediately on kill(). Production code never calls this. */
  _seedEntryForTest(input: {
    terminalId: string;
    linkedSessionId: string | null;
    killExit?: { exitCode: number; signal?: number };
  }): void {
    let exitCb: (e: { exitCode: number; signal?: number }) => void = () => {};
    const killExit = input.killExit ?? { exitCode: 0 };
    const fakeProc: any = {
      pid: -1,
      onData: () => {},
      onExit: (cb: typeof exitCb) => { exitCb = cb; },
      write: () => {},
      resize: () => {},
      kill: () => { exitCb(killExit); },
    };
    const entry: ClaudePtyEntry = {
      terminalId: input.terminalId,
      kind: "claude_new",
      proc: fakeProc,
      scrollback: "",
      clients: new Set(),
      cwd: "/tmp",
      command: "/bin/echo",
      args: [],
      startedAt: Date.now(),
      exitedAt: null,
      linkedSessionId: input.linkedSessionId,
      evictTimer: null,
    };
    // Wire the onExit listener the same way spawn() does.
    fakeProc.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      this._handleExit(entry, { exitCode, signal: signalName(signal) });
    });
    this.terminals.set(input.terminalId, entry);
  }
}
