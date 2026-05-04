import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";

const SCROLLBACK_LIMIT = 50_000; // chars to replay on reconnect

let scrollback = "";
const clients = new Set<WebSocket>();
let proc: any;
let ptyAvailable = false;
let ptyModule: any;

// Dynamic import — try @lydell/node-pty (prebuilt), fall back to node-pty
try {
  ptyModule = await import("@lydell/node-pty");
  ptyAvailable = true;
  console.log("[pty] loaded @lydell/node-pty");
} catch {
  try {
    // @ts-ignore — fallback, may not be installed
    ptyModule = await import("node-pty");
    ptyAvailable = true;
    console.log("[pty] loaded node-pty");
  } catch {
    console.log("[pty] node-pty not available — terminal disabled");
  }
}

export function spawnSession(
  shell: string,
  shellArgs: string[],
  cwd: string,
  env: Record<string, string>,
) {
  if (!ptyAvailable) return;
  if (proc) return proc;

  console.log(`Spawning ${shell} in ${cwd}`);
  const pty = ptyModule.default ?? ptyModule;
  proc = pty.spawn(shell, shellArgs, {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd,
    env,
  });

  proc.onData((data: string) => {
    scrollback += data;
    if (scrollback.length > SCROLLBACK_LIMIT) {
      scrollback = scrollback.slice(-SCROLLBACK_LIMIT);
    }
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  });

  proc.onExit(({ exitCode }: { exitCode: number }) => {
    console.log(`Session exited with code ${exitCode}`);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send("\r\n\x1b[90m[session ended]\x1b[0m\r\n");
      }
    }
  });

  return proc;
}

export function attachWebSocket(
  httpServer: Server,
  spawnParams?: { shell: string; shellArgs: string[]; cwd: string; env: Record<string, string> },
) {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws: WebSocket) => {
    console.log(`Client connected (${clients.size + 1} total)`);
    clients.add(ws);

    if (!ptyAvailable) {
      ws.send("\r\n\x1b[90m[terminal not available — node-pty not installed]\x1b[0m\r\n");
      ws.on("close", () => { clients.delete(ws); });
      return;
    }

    // Lazy-spawn the PTY shell on first connection. Spawning at boot doubled
    // startup time (~11s) because two opencode-ai processes initialised in
    // parallel and competed for CPU. The terminal window is rarely opened —
    // most users never trigger this. See #385.
    if (spawnParams && !proc) {
      spawnSession(spawnParams.shell, spawnParams.shellArgs, spawnParams.cwd, spawnParams.env);
    }

    // Replay scrollback so reconnecting clients see current state
    if (scrollback.length > 0) {
      ws.send(scrollback);
    }

    // Client → PTY
    ws.on("message", (msg: Buffer | string) => {
      if (!proc) return;
      const data = typeof msg === "string" ? msg : msg.toString("utf-8");

      // Handle resize messages
      if (data.startsWith("\x01resize:")) {
        const parts = data.slice(8).split(",");
        const cols = parseInt(parts[0], 10);
        const rows = parseInt(parts[1], 10);
        if (cols > 0 && rows > 0) {
          proc.resize(cols, rows);
        }
        return;
      }

      proc.write(data);
    });

    ws.on("close", () => {
      clients.delete(ws);
      console.log(`Client disconnected (${clients.size} remaining)`);
    });
  });
}
