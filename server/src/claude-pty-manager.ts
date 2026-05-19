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
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { SessionStore } from "./session-store.js";
import type { UiCommand } from "../../shared/types.js";

export interface ClaudePtyManagerDeps {
  sessionStore: SessionStore;
  broadcastUiEvent: (cmd: UiCommand) => void;
}

const SCROLLBACK_LIMIT = 50_000;
const POST_EXIT_RETENTION_MS = 30_000;
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
  private broadcastUiEvent: (cmd: UiCommand) => void;

  constructor(deps: ClaudePtyManagerDeps) {
    this.sessionStore = deps.sessionStore;
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

    proc.onExit(({ exitCode }: { exitCode: number }) => {
      entry.exitedAt = Date.now();
      const closeNote = `\r\n\x1b[90m[session ended (exit ${exitCode})]\x1b[0m\r\n`;
      entry.scrollback += closeNote;
      for (const ws of entry.clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(closeNote);
      }
      if (entry.linkedSessionId) {
        this.sessionStore.clearTerminal(entry.linkedSessionId);
      }
      // Retain for late reconnects, then evict.
      entry.evictTimer = setTimeout(() => {
        this.terminals.delete(terminalId);
      }, POST_EXIT_RETENTION_MS);
    });

    return { terminalId, startedAt };
  }

  attachClient(terminalId: string, ws: WebSocket): boolean {
    const entry = this.terminals.get(terminalId);
    if (!entry) return false;
    entry.clients.add(ws);
    if (entry.linkedSessionId) {
      this.sessionStore.setAttachedClients(entry.linkedSessionId, entry.clients.size);
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
      if (entry.linkedSessionId) {
        this.sessionStore.setAttachedClients(entry.linkedSessionId, entry.clients.size);
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

  kill(terminalId: string): boolean {
    const entry = this.terminals.get(terminalId);
    if (!entry) return false;
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

  /** Test-only: pair `_seedEntryForTest` with a link write in one step. */
  linkTerminalForTest(terminalId: string, sessionId: string): void { this.setLinkedSession(terminalId, sessionId); }

  /** Test-only: inject a fake entry with a stub proc whose onExit fires
   *  immediately on kill(). Production code never calls this. */
  _seedEntryForTest(input: { terminalId: string; linkedSessionId: string | null }): void {
    let exitCb: (e: { exitCode: number }) => void = () => {};
    const fakeProc: any = {
      pid: -1,
      onData: () => {},
      onExit: (cb: typeof exitCb) => { exitCb = cb; },
      write: () => {},
      resize: () => {},
      kill: () => { exitCb({ exitCode: 0 }); },
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
    fakeProc.onExit((event: { exitCode: number }) => {
      entry.exitedAt = Date.now();
      if (entry.linkedSessionId) {
        this.sessionStore.clearTerminal(entry.linkedSessionId);
      }
    });
    this.terminals.set(input.terminalId, entry);
  }
}
