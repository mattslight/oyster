import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, dirname } from "node:path";
import { spawn } from "node:child_process";
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
  registerGeneratedArtifact,
  updateGeneratedArtifact,
} from "./process-manager.js";
import { IconGenerator } from "./icon-generator.js";

const PORT = 4200;
const OPENCODE_PORT = 4096;
const SHELL = process.env.OYSTER_SHELL || "opencode";
const SHELL_ARGS = SHELL === "opencode" ? ["."] : [];
const WORKSPACE = process.env.OYSTER_WORKSPACE || process.cwd();
const SCROLLBACK_LIMIT = 50_000; // chars to replay on reconnect
// WORKSPACE is the server dir; project root is one level up
const PROJECT_ROOT = WORKSPACE.replace(/\/server\/?$/, "");

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

// ── OpenCode serve (headless API server) ──

let shuttingDown = false;
let opencodeRestarts = 0;
const MAX_RESTARTS = 10;

function spawnOpenCodeServe() {
  console.log(`Spawning opencode serve on port ${OPENCODE_PORT} in ${PROJECT_ROOT}`);
  const child = spawn("opencode", ["serve", "--port", String(OPENCODE_PORT)], {
    cwd: PROJECT_ROOT,
    env: cleanEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (data: Buffer) => {
    console.log(`[opencode-serve] ${data.toString().trim()}`);
  });

  child.stderr?.on("data", (data: Buffer) => {
    console.error(`[opencode-serve] ${data.toString().trim()}`);
  });

  child.on("exit", (code) => {
    if (shuttingDown) return;
    opencodeRestarts++;
    if (opencodeRestarts > MAX_RESTARTS) {
      console.error("[opencode-serve] too many restarts, giving up");
      return;
    }
    const delay = Math.min(2000 * opencodeRestarts, 30000);
    console.log(`[opencode-serve] exited (code ${code}), restarting in ${delay}ms...`);
    setTimeout(spawnOpenCodeServe, delay);
  });

  return child;
}

spawnOpenCodeServe();

process.on("SIGTERM", () => { shuttingDown = true; process.exit(0); });
process.on("SIGINT", () => { shuttingDown = true; process.exit(0); });

// ── Auto-approve permission requests from opencode ──
// In the PoC, we trust all tool use. This listens to the SSE stream
// and auto-approves any permission.asked events.

// ── Artefact detection ──
// Artefacts live in /artefacts/<id>/ with a manifest.json and src/ directory.
// The server detects them by scanning for manifest.json files or falling back
// to filename-based inference for legacy/unmanifested files.

const seenArtefacts = new Set<string>();

const ARTEFACTS_DIR = `${PROJECT_ROOT}/artefacts/`;

const iconGenerator = new IconGenerator(updateGeneratedArtifact);

// Legacy dirs — kept for backward compat with existing demo content in web/public/
const LEGACY_DIRS = [
  { prefix: `${PROJECT_ROOT}/web/public/`, serve: "/", space: "generated" },
];

interface ArtefactManifest {
  id: string;
  name: string;
  type: string;
  runtime: string;
  entrypoint: string;
  ports: number[];
  storage: string;
  capabilities: string[];
  status: string;
  created_at: string;
  updated_at: string;
}

function tryReadManifest(artefactDir: string): ArtefactManifest | null {
  const manifestPath = join(artefactDir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function inferType(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.includes("dashboard") || lower.includes("diagram")) return "diagram";
  if (lower.includes("deck") || lower.includes("slide") || lower.includes("present")) return "deck";
  if (lower.includes("map") || lower.includes("mind")) return "map";
  if (lower.includes("note") || lower.includes("readme")) return "notes";
  if (lower.includes("table") || lower.includes("spreadsheet") || lower.includes("tracker")) return "table";
  if (lower.endsWith(".md")) return "notes";
  return "app";
}

// Filenames can't contain apostrophes, so override display names here
const NAME_OVERRIDES: Record<string, string> = {
  "the-worlds-your-oyster": "The World's Your Oyster",
};

function inferName(filePath: string): string {
  const base = filePath.split("/").pop() || "untitled";
  const stem = base.replace(/\.[^.]+$/, "");

  // For index.html files, use the parent directory name instead
  if (stem.toLowerCase() === "index") {
    const parentDir = dirname(filePath).split("/").pop() || "untitled";
    if (NAME_OVERRIDES[parentDir]) return NAME_OVERRIDES[parentDir];
    return parentDir
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  if (NAME_OVERRIDES[stem]) return NAME_OVERRIDES[stem];
  return stem
    .replace(/[-_]/g, " ")         // dashes/underscores to spaces
    .replace(/\b\w/g, (c) => c.toUpperCase()); // title case
}

function detectExistingIcon(artefactDir: string): { icon: string; iconStatus: "ready" } | {} {
  const dirName = artefactDir.split("/").pop();
  const iconPath = join(artefactDir, "icon.png");
  if (existsSync(iconPath)) {
    return { icon: `/artefacts/${dirName}/icon.png`, iconStatus: "ready" as const };
  }
  return {};
}

function registerArtefactFromManifest(manifest: ArtefactManifest, artefactDir: string) {
  const id = `gen:${manifest.id}`;
  if (seenArtefacts.has(id)) return;

  const entrypointPath = join(artefactDir, manifest.entrypoint);
  const servePath = `/artefacts/${manifest.id}/${manifest.entrypoint}`;

  seenArtefacts.add(id);
  console.log(`[artefact-detect] manifest: ${manifest.name} (${manifest.type}) → ${servePath}`);

  registerGeneratedArtifact({
    id,
    name: manifest.name,
    type: manifest.type,
    status: "ready",
    path: servePath,
    space: "generated",
    createdAt: manifest.created_at,
    ...detectExistingIcon(artefactDir),
  }, entrypointPath);

  // Queue icon generation for this artifact
  iconGenerator.enqueue(id, manifest.name, manifest.type, artefactDir);
}

function handleFileEdited(rawPath: string) {
  // Resolve relative paths against workspace
  const filePath = rawPath.startsWith("/") ? rawPath : `${WORKSPACE}/${rawPath}`;

  // Check if this file is inside /artefacts/<id>/
  if (filePath.startsWith(ARTEFACTS_DIR)) {
    const relativePath = filePath.slice(ARTEFACTS_DIR.length);
    const artefactId = relativePath.split("/")[0];
    if (!artefactId) return;

    const artefactDir = join(ARTEFACTS_DIR, artefactId);
    const id = `gen:${artefactId}`;
    if (seenArtefacts.has(id)) return;

    // Try manifest first
    const manifest = tryReadManifest(artefactDir);
    if (manifest) {
      registerArtefactFromManifest(manifest, artefactDir);
      return;
    }

    // Fallback: no manifest, infer from the file
    const ext = extname(filePath);
    if (ext !== ".html" && ext !== ".htm" && ext !== ".md") return;

    const name = inferName(filePath);
    const type = inferType(filePath);
    const serveRelative = filePath.slice(PROJECT_ROOT.length);

    seenArtefacts.add(id);
    console.log(`[artefact-detect] inferred: ${name} (${type}) → ${serveRelative}`);

    registerGeneratedArtifact({
      id,
      name,
      type,
      status: "ready",
      path: serveRelative,
      space: "generated",
      createdAt: new Date().toISOString(),
      ...detectExistingIcon(artefactDir),
    }, filePath);

    // Queue icon generation for this artifact
    iconGenerator.enqueue(id, name, type, artefactDir);
    return;
  }

  // Legacy: check old dirs (web/public/)
  for (const dir of LEGACY_DIRS) {
    if (filePath.startsWith(dir.prefix)) {
      const relativePath = filePath.slice(dir.prefix.length);
      if (!filePath.endsWith(".html") && !filePath.endsWith(".htm") && !filePath.endsWith(".md")) return;
      if (relativePath.startsWith("demo/") || relativePath.endsWith(".svg")) return;

      const id = `gen:${relativePath}`;
      if (seenArtefacts.has(id)) return;

      const servePath = dir.serve + relativePath;
      const name = inferName(filePath);
      const type = inferType(filePath);

      seenArtefacts.add(id);
      console.log(`[artefact-detect] legacy: ${name} (${type}) → ${servePath}`);

      registerGeneratedArtifact({
        id,
        name,
        type,
        status: "ready",
        path: servePath,
        space: dir.space,
        createdAt: new Date().toISOString(),
      }, filePath);
      return;
    }
  }
}

// Scan /artefacts/ subdirectories for existing artefacts on startup
function scanExistingArtefacts() {
  // Scan /artefacts/<id>/ directories
  if (existsSync(ARTEFACTS_DIR)) {
    try {
      const entries = readdirSync(ARTEFACTS_DIR);
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const artefactDir = join(ARTEFACTS_DIR, entry);
        try {
          if (!statSync(artefactDir).isDirectory()) continue;
        } catch { continue; }

        // Try manifest first
        const manifest = tryReadManifest(artefactDir);
        if (manifest) {
          registerArtefactFromManifest(manifest, artefactDir);
          continue;
        }

        // Fallback: look for index.html or any HTML/MD file
        try {
          const files = readdirSync(artefactDir);
          // Check for src/index.html first (standard convention)
          const srcDir = join(artefactDir, "src");
          if (existsSync(srcDir)) {
            const srcFiles = readdirSync(srcDir);
            for (const f of srcFiles) {
              if (f.endsWith(".html") || f.endsWith(".md")) {
                handleFileEdited(join(srcDir, f));
                break;
              }
            }
          } else {
            // Check artefact root for HTML/MD files
            for (const f of files) {
              if (f.endsWith(".html") || f.endsWith(".md")) {
                handleFileEdited(join(artefactDir, f));
                break;
              }
            }
          }
        } catch {}
      }
    } catch {}
  }

  // Legacy: scan web/public/ for top-level files
  for (const dir of LEGACY_DIRS) {
    if (!existsSync(dir.prefix)) continue;
    try {
      const files = readdirSync(dir.prefix);
      for (const file of files) {
        const fullPath = dir.prefix + file;
        try {
          if (statSync(fullPath).isFile()) {
            handleFileEdited(fullPath);
          }
        } catch {}
      }
    } catch {}
  }
}

scanExistingArtefacts();

async function startAutoApprover() {
  try {
    const res = await fetch(`http://127.0.0.1:${OPENCODE_PORT}/event`, {
      headers: { Accept: "text/event-stream" },
    });
    if (!res.ok || !res.body) {
      console.log("[auto-approver] failed to connect, retrying in 3s...");
      setTimeout(startAutoApprover, 3000);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    async function pump() {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "permission.asked") {
              const requestId = event.properties.id;
              console.log(`[auto-approver] approving ${requestId}: ${event.properties.permission}`);
              fetch(`http://127.0.0.1:${OPENCODE_PORT}/permission/${requestId}/reply`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reply: "always" }),
              }).catch(() => {});
            }

            // Auto-detect new artifacts from file.edited events
            if (event.type === "file.edited") {
              const file = event.properties.file as string | undefined;
              if (file) handleFileEdited(file);
            }
          } catch {}
        }
      }
    }

    pump().catch(() => {}).finally(() => {
      if (!shuttingDown) {
        console.log("[auto-approver] disconnected, reconnecting in 3s...");
        setTimeout(startAutoApprover, 3000);
      }
    });
  } catch {
    if (!shuttingDown) setTimeout(startAutoApprover, 3000);
  }
}

// Give opencode serve a moment to start before connecting
setTimeout(startAutoApprover, 3000);

// ── Proxy helpers for opencode API ──

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(""));
  });
}

async function proxyToOpenCode(
  req: IncomingMessage,
  res: ServerResponse,
  targetPath: string
) {
  const method = req.method || "GET";
  const url = `http://127.0.0.1:${OPENCODE_PORT}${targetPath}`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const fetchOpts: RequestInit = { method, headers };

  if (method === "POST" || method === "PATCH" || method === "PUT") {
    fetchOpts.body = await readBody(req);
  }

  try {
    const upstream = await fetch(url, fetchOpts);
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
    });
    const text = await upstream.text();
    res.end(text);
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "opencode serve unavailable" }));
  }
}

async function proxySSE(
  req: IncomingMessage,
  res: ServerResponse,
  targetPath: string
) {
  const url = `http://127.0.0.1:${OPENCODE_PORT}${targetPath}`;

  try {
    const upstream = await fetch(url, {
      headers: { Accept: "text/event-stream" },
    });

    if (!upstream.ok || !upstream.body) {
      res.writeHead(upstream.status);
      res.end();
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    async function pump() {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
      }
      res.end();
    }

    pump().catch(() => res.end());

    req.on("close", () => {
      reader.cancel();
    });
  } catch {
    res.writeHead(502);
    res.end();
  }
}

// ── HTTP request handler ──

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const url = req.url || "/";

  // GET /api/artifacts
  if (url === "/api/artifacts") {
    const artifacts = await getAllArtifacts((id) => seenArtefacts.delete(id));
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
  const docsMatch = url.split("?")[0].match(/^\/docs\/([^/]+)$/);
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

  // ── OpenCode chat API proxy ──

  // Handle CORS preflight for POST routes
  if (req.method === "OPTIONS" && url.startsWith("/api/chat/")) {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // GET /api/chat/events → SSE proxy
  if (url === "/api/chat/events" || url.startsWith("/api/chat/events?")) {
    await proxySSE(req, res, "/event");
    return;
  }

  // GET /api/chat/doc → OpenAPI spec
  if (url === "/api/chat/doc") {
    await proxyToOpenCode(req, res, "/doc");
    return;
  }

  // POST /api/chat/session → create session
  if (url === "/api/chat/session" && req.method === "POST") {
    await proxyToOpenCode(req, res, "/session");
    return;
  }

  // GET /api/chat/session → list sessions
  if (url === "/api/chat/session" && req.method === "GET") {
    await proxyToOpenCode(req, res, "/session");
    return;
  }

  // POST /api/chat/session/:id/message → send message
  const msgMatch = url.match(/^\/api\/chat\/session\/([^/]+)\/message$/);
  if (msgMatch && req.method === "POST") {
    await proxyToOpenCode(req, res, `/session/${msgMatch[1]}/message`);
    return;
  }

  // GET /api/chat/session/:id/message → list messages
  if (msgMatch && req.method === "GET") {
    await proxyToOpenCode(req, res, `/session/${msgMatch[1]}/message`);
    return;
  }

  // GET /api/chat/session/:id → get session
  const sessionMatch = url.match(/^\/api\/chat\/session\/([^/]+)$/);
  if (sessionMatch && req.method === "GET") {
    await proxyToOpenCode(req, res, `/session/${sessionMatch[1]}`);
    return;
  }

  // POST /api/chat/session/:id/abort → abort session
  const abortMatch = url.match(/^\/api\/chat\/session\/([^/]+)\/abort$/);
  if (abortMatch && req.method === "POST") {
    await proxyToOpenCode(req, res, `/session/${abortMatch[1]}/abort`);
    return;
  }

  // GET /api/chat/permission → list pending permissions
  if (url === "/api/chat/permission" && req.method === "GET") {
    await proxyToOpenCode(req, res, "/permission");
    return;
  }

  // POST /api/chat/question/:id/reply → reply to question
  const questionMatch = url.match(/^\/api\/chat\/question\/([^/]+)\/reply$/);
  if (questionMatch && req.method === "POST") {
    await proxyToOpenCode(req, res, `/question/${questionMatch[1]}/reply`);
    return;
  }

  // ── Static file serving for /artefacts/ ──
  if (url.startsWith("/artefacts/")) {
    const urlPath = url.split("?")[0]; // Strip query params
    const relativePath = urlPath.slice("/artefacts/".length);
    const filePath = join(ARTEFACTS_DIR, relativePath);

    // Security: prevent path traversal
    if (!filePath.startsWith(ARTEFACTS_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = extname(filePath);
    const mime = MIME[ext] || "application/octet-stream";

    if (ext === ".md") {
      const content = readFileSync(filePath, "utf8");
      const rendered = marked(content);
      const name = inferName(filePath);
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
