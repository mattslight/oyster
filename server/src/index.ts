import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { marked } from "marked";
import pty from "node-pty";
import {
  loadRegistry,
  getAllArtifacts,
  startApp,
  stopApp,
  isPortOpen,
  waitForReady,
} from "./process-manager.js";

const PORT = 4200;
const SHELL = process.env.OYSTER_SHELL || "opencode";
const SHELL_ARGS = SHELL === "opencode" ? ["."] : [];
const WORKSPACE = process.env.OYSTER_WORKSPACE || process.cwd();
const SCROLLBACK_LIMIT = 50_000; // chars to replay on reconnect

// ── MIME types ──

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".md": "text/html",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

// ── Build docs lookup from registry ──

const registry = loadRegistry();
const docsMap = new Map<string, string>();
for (const doc of registry.docs) {
  docsMap.set(doc.name, doc.file);
}

// ── Persistent PTY session ──

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

  p.onExit(({ exitCode }) => {
    console.log(`Session exited with code ${exitCode}`);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send("\r\n\x1b[90m[session ended]\x1b[0m\r\n");
      }
    }
  });

  return p;
}

// ── HTTP request handler ──

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const url = req.url || "/";

  // GET /api/artifacts
  if (url === "/api/artifacts") {
    const artifacts = await getAllArtifacts();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(artifacts));
    return;
  }

  // GET /api/apps/:name/start
  const startMatch = url.match(/^\/api\/apps\/([^/]+)\/start$/);
  if (startMatch) {
    const name = startMatch[1];
    const app = registry.apps.find((a) => a.name === name);
    if (!app) {
      res.writeHead(404);
      res.end("Unknown app");
      return;
    }
    if (await isPortOpen(app.port)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "already_running" }));
      return;
    }
    startApp(name);
    try {
      await waitForReady(app.port);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "started", port: app.port }));
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "timeout" }));
    }
    return;
  }

  // GET /api/apps/:name/stop
  const stopMatch = url.match(/^\/api\/apps\/([^/]+)\/stop$/);
  if (stopMatch) {
    const name = stopMatch[1];
    const app = registry.apps.find((a) => a.name === name);
    if (!app) {
      res.writeHead(404);
      res.end("Unknown app");
      return;
    }
    const stopped = stopApp(name);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: stopped ? "stopped" : "not_managed" }));
    return;
  }

  // GET /docs/:name
  const docsMatch = url.match(/^\/docs\/([^/]+)$/);
  if (docsMatch) {
    const name = docsMatch[1];
    const filePath = docsMap.get(name);
    if (!filePath || !existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = extname(filePath);
    const mime = MIME[ext] || "application/octet-stream";

    if (ext === ".md") {
      const content = readFileSync(filePath, "utf8");
      const rendered = marked(content);
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${name}</title><style>
body { font-family: 'Space Grotesk', -apple-system, sans-serif; padding: 2.5rem; max-width: 72ch; margin: 0 auto; background: #1a1b2e; color: #e8e9f0; line-height: 1.7; }
h1, h2, h3 { color: #fff; font-weight: 600; letter-spacing: -0.02em; }
h1 { font-size: 1.8rem; margin-top: 0; }
h2 { font-size: 1.3rem; margin-top: 2rem; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 0.4rem; }
a { color: #21b981; text-decoration: none; }
a:hover { text-decoration: underline; }
code { background: rgba(255,255,255,0.06); padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.9em; font-family: 'IBM Plex Mono', monospace; }
pre { background: rgba(255,255,255,0.04); padding: 1rem; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid rgba(255,255,255,0.06); }
th { color: rgba(232,233,240,0.6); font-weight: 500; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.05em; }
blockquote { border-left: 3px solid #21b981; margin: 1rem 0; padding: 0.5rem 1rem; color: rgba(232,233,240,0.7); }
ul, ol { padding-left: 1.5rem; }
li { margin: 0.3rem 0; }
</style></head><body>${rendered}</body></html>`;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } else {
      res.writeHead(200, { "Content-Type": mime });
      res.end(readFileSync(filePath));
    }
    return;
  }

  // Fallback
  res.writeHead(404);
  res.end("Not found");
}

// ── HTTP + WebSocket server ──

const clients = new Set<WebSocket>();
const httpServer = createServer(handleHttpRequest);
const wss = new WebSocketServer({ server: httpServer });

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
  });
});

httpServer.listen(PORT, () => {
  console.log(`Oyster server listening on http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}`);
  console.log(`  API:       http://localhost:${PORT}/api/artifacts`);
});
