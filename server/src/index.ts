import { WebSocketServer, WebSocket } from "ws";
import pty from "node-pty";

const PORT = 4200;
const SHELL = process.env.OYSTER_SHELL || "opencode";
const SHELL_ARGS = SHELL === "opencode" ? ["."] : [];
const WORKSPACE = process.env.OYSTER_WORKSPACE || process.cwd();
const SCROLLBACK_LIMIT = 50_000; // chars to replay on reconnect

// ── Persistent PTY session ──
// OpenCode spawns once and stays alive. Clients attach/detach.

const cleanEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) cleanEnv[k] = v;
}

let scrollback = "";
let proc = spawnSession();

function spawnSession() {
  console.log(`Spawning ${SHELL} in ${WORKSPACE}`);
  const p = pty.spawn(SHELL, SHELL_ARGS, {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: WORKSPACE,
    env: cleanEnv,
  });

  p.onData((data: string) => {
    // Buffer output for reconnecting clients
    scrollback += data;
    if (scrollback.length > SCROLLBACK_LIMIT) {
      scrollback = scrollback.slice(-SCROLLBACK_LIMIT);
    }
    // Broadcast to all connected clients
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  });

  p.onExit(({ exitCode }) => {
    console.log(`Session exited with code ${exitCode}`);
    // Notify all clients
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send("\r\n\x1b[90m[session ended]\x1b[0m\r\n");
      }
    }
  });

  return p;
}

// ── WebSocket server ──
// Clients connect/disconnect freely. The PTY session persists.

const clients = new Set<WebSocket>();

const wss = new WebSocketServer({ port: PORT });
console.log(`PTY WebSocket server listening on ws://localhost:${PORT}`);

wss.on("connection", (ws: WebSocket) => {
  console.log(`Client connected (${clients.size + 1} total)`);
  clients.add(ws);

  // Replay scrollback so reconnecting clients see current state
  if (scrollback.length > 0) {
    ws.send(scrollback);
  }

  // Client → PTY
  ws.on("message", (msg: Buffer | string) => {
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
    // PTY keeps running — no kill
  });
});
