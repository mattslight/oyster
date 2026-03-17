import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, copyFileSync } from "node:fs";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
import { injectBridge } from "./error-bridge.js";

const PORT = 4200;
const OPENCODE_PORT = 4096;
const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENCODE_BIN = join(__dirname, "..", "node_modules", ".bin", "opencode");
const SHELL = process.env.OYSTER_SHELL || OPENCODE_BIN;
const SHELL_ARGS = SHELL.endsWith("opencode") ? ["."] : [];
const WORKSPACE = process.env.OYSTER_WORKSPACE || process.cwd();
const SCROLLBACK_LIMIT = 50_000; // chars to replay on reconnect
// WORKSPACE is the server dir; project root is one level up
const PROJECT_ROOT = WORKSPACE.replace(/\/server\/?$/, "");

// ── Userland isolation ──
// The agent runs in a sandboxed directory so it cannot see or write to
// web/, server/, or any system files.
const USERLAND_DIR = process.env.OYSTER_USERLAND || `${PROJECT_ROOT}/userland`;

function syncIfNewer(src: string, dest: string) {
  let shouldCopy = !existsSync(dest);
  if (!shouldCopy) {
    shouldCopy = statSync(src).mtimeMs > statSync(dest).mtimeMs;
  }
  if (shouldCopy) copyFileSync(src, dest);
}

function bootstrapUserland() {
  mkdirSync(USERLAND_DIR, { recursive: true });
  mkdirSync(`${USERLAND_DIR}/.opencode/agents`, { recursive: true });

  // Sync OpenCode config files from repo → userland/.opencode/
  // Repo is source of truth; only overwrite if source is newer
  syncIfNewer(
    `${PROJECT_ROOT}/.opencode/agents/oyster.md`,
    `${USERLAND_DIR}/.opencode/agents/oyster.md`,
  );
  syncIfNewer(
    `${PROJECT_ROOT}/.opencode/config.toml`,
    `${USERLAND_DIR}/.opencode/config.toml`,
  );
}

bootstrapUserland();

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
delete cleanEnv["OPENAI_API_KEY"];

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
  console.log(`Spawning opencode serve on port ${OPENCODE_PORT} in ${USERLAND_DIR}`);
  const child = spawn(OPENCODE_BIN, ["serve", "--port", String(OPENCODE_PORT)], {
    cwd: USERLAND_DIR,
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

// ── Artifact detection ──
// Artifacts live in userland/<id>/ with a manifest.json and src/ directory.
// The server detects them by scanning for manifest.json files or falling back
// to filename-based inference. New artifacts start as "generating" and
// transition to "ready" after quiescence + entrypoint exists.

const seenArtifacts = new Set<string>();

const ARTIFACTS_DIR = `${USERLAND_DIR}/`;

const iconGenerator = new IconGenerator(updateGeneratedArtifact);

// ── Generating lifecycle ──
// Tracks artifacts currently being generated by the agent.
// Readiness = quiescence (no writes for GENERATION_QUIESCE_MS) AND entrypoint exists.

interface GeneratingInfo {
  name: string;
  type: string;
  dir: string;
  lastActivity: number;
}
const generatingArtifacts = new Map<string, GeneratingInfo>();
const GENERATION_QUIESCE_MS = 8_000;
const GENERATION_MAX_MS = 5 * 60_000; // Abandon after 5 minutes with no entrypoint

setInterval(() => {
  const now = Date.now();
  for (const [id, info] of generatingArtifacts) {
    if (now - info.lastActivity < GENERATION_QUIESCE_MS) continue;

    // Verify entrypoint exists
    const manifest = tryReadManifest(info.dir);
    const entrypoint = manifest
      ? join(info.dir, manifest.entrypoint)
      : join(info.dir, "src", "index.html");

    if (!existsSync(entrypoint)) {
      // Abandon if generating for too long without an entrypoint
      if (now - info.lastActivity > GENERATION_MAX_MS) {
        console.log(`[artifact-detect] abandoned: ${info.name} (no entrypoint after ${GENERATION_MAX_MS / 1000}s)`);
        generatingArtifacts.delete(id);
        seenArtifacts.delete(id);
      }
      continue;
    }

    // Transition to ready
    generatingArtifacts.delete(id);
    const name = manifest?.name || info.name;
    const type = manifest?.type || info.type;
    const dirName = info.dir.split("/").pop();
    const servePath = manifest
      ? `/artifacts/${manifest.id}/${manifest.entrypoint}`
      : `/artifacts/${dirName}/src/index.html`;

    updateGeneratedArtifact(id, { status: "ready", name, type, path: servePath }, entrypoint);
    iconGenerator.enqueue(id, name, type, info.dir);
    console.log(`[artifact-detect] ready: ${name}`);
  }
}, 2000);

interface ArtifactManifest {
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

function tryReadManifest(artifactDir: string): ArtifactManifest | null {
  const manifestPath = join(artifactDir, "manifest.json");
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

function detectExistingIcon(artifactDir: string): { icon: string; iconStatus: "ready" } | {} {
  const dirName = artifactDir.split("/").pop();
  const iconPath = join(artifactDir, "icon.png");
  if (existsSync(iconPath)) {
    return { icon: `/artifacts/${dirName}/icon.png`, iconStatus: "ready" as const };
  }
  return {};
}

function registerArtifactFromManifest(manifest: ArtifactManifest, artifactDir: string, generating = false) {
  const id = `gen:${manifest.id}`;
  if (seenArtifacts.has(id)) return;

  const entrypointPath = join(artifactDir, manifest.entrypoint);
  const servePath = `/artifacts/${manifest.id}/${manifest.entrypoint}`;

  seenArtifacts.add(id);

  if (generating) {
    console.log(`[artifact-detect] generating: ${manifest.name} (${manifest.type})`);
    registerGeneratedArtifact({
      id,
      name: manifest.name,
      type: manifest.type,
      status: "generating",
      path: servePath,
      space: "generated",
      createdAt: manifest.created_at,
    }); // No filePath — prevents self-healing deletion while entrypoint doesn't exist
    generatingArtifacts.set(id, {
      name: manifest.name,
      type: manifest.type,
      dir: artifactDir,
      lastActivity: Date.now(),
    });
  } else {
    console.log(`[artifact-detect] manifest: ${manifest.name} (${manifest.type}) → ${servePath}`);
    registerGeneratedArtifact({
      id,
      name: manifest.name,
      type: manifest.type,
      status: "ready",
      path: servePath,
      space: "generated",
      createdAt: manifest.created_at,
      ...detectExistingIcon(artifactDir),
    }, entrypointPath);
    iconGenerator.enqueue(id, manifest.name, manifest.type, artifactDir);
  }
}

function handleFileEdited(rawPath: string) {
  // Resolve relative paths against userland
  const filePath = rawPath.startsWith("/") ? rawPath : `${USERLAND_DIR}/${rawPath}`;

  // Check if this file is inside userland
  if (filePath.startsWith(ARTIFACTS_DIR)) {
    const relativePath = filePath.slice(ARTIFACTS_DIR.length);
    const topDir = relativePath.split("/")[0];
    if (!topDir || topDir.startsWith(".")) return; // Skip dotdirs (.opencode/, .git/, etc.)
    const artifactId = topDir;

    const artifactDir = join(ARTIFACTS_DIR, artifactId);
    const id = `gen:${artifactId}`;

    // Already tracking this artifact — update activity timestamp
    if (seenArtifacts.has(id)) {
      if (generatingArtifacts.has(id)) {
        generatingArtifacts.get(id)!.lastActivity = Date.now();
        // Re-read manifest if it arrived after initial registration
        const manifest = tryReadManifest(artifactDir);
        if (manifest) {
          updateGeneratedArtifact(id, { name: manifest.name, type: manifest.type });
        }
      }
      return;
    }

    // Try manifest first
    const manifest = tryReadManifest(artifactDir);
    if (manifest) {
      registerArtifactFromManifest(manifest, artifactDir, true);
      return;
    }

    // Fallback: no manifest yet, register as generating with inferred info
    // Use the directory name (artifact ID) for inference, not the individual file
    const name = inferName(join(artifactDir, "index.html"));
    const type = inferType(artifactDir);

    seenArtifacts.add(id);
    console.log(`[artifact-detect] generating (inferred): ${name} (${type})`);

    registerGeneratedArtifact({
      id,
      name,
      type,
      status: "generating",
      path: "",
      space: "generated",
      createdAt: new Date().toISOString(),
    }); // No filePath — prevents self-healing deletion

    generatingArtifacts.set(id, {
      name,
      type,
      dir: artifactDir,
      lastActivity: Date.now(),
    });
    return;
  }
}

// Scan userland subdirectories for existing artifacts on startup
function scanExistingArtifacts() {
  // Scan userland/<id>/ directories
  if (existsSync(ARTIFACTS_DIR)) {
    try {
      const entries = readdirSync(ARTIFACTS_DIR);
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const artifactDir = join(ARTIFACTS_DIR, entry);
        try {
          if (!statSync(artifactDir).isDirectory()) continue;
        } catch { continue; }

        // Try manifest first
        const manifest = tryReadManifest(artifactDir);
        if (manifest) {
          registerArtifactFromManifest(manifest, artifactDir);
          continue;
        }

        // Fallback: look for index.html or any HTML/MD file and register as ready
        try {
          let foundFile: string | null = null;
          // Check for src/index.html first (standard convention)
          const srcDir = join(artifactDir, "src");
          if (existsSync(srcDir)) {
            const srcFiles = readdirSync(srcDir);
            for (const f of srcFiles) {
              if (f.endsWith(".html") || f.endsWith(".md")) {
                foundFile = join(srcDir, f);
                break;
              }
            }
          } else {
            const files = readdirSync(artifactDir);
            for (const f of files) {
              if (f.endsWith(".html") || f.endsWith(".md")) {
                foundFile = join(artifactDir, f);
                break;
              }
            }
          }
          if (foundFile) {
            const id = `gen:${entry}`;
            if (!seenArtifacts.has(id)) {
              const name = inferName(foundFile);
              const type = inferType(foundFile);
              const serveRelative = `/artifacts/${foundFile.slice(ARTIFACTS_DIR.length)}`;
              seenArtifacts.add(id);
              console.log(`[artifact-detect] scan: ${name} (${type}) → ${serveRelative}`);
              registerGeneratedArtifact({
                id,
                name,
                type,
                status: "ready",
                path: serveRelative,
                space: "generated",
                createdAt: new Date().toISOString(),
                ...detectExistingIcon(artifactDir),
              }, foundFile);
              iconGenerator.enqueue(id, name, type, artifactDir);
            }
          }
        } catch {}
      }
    } catch {}
  }

}

scanExistingArtifacts();

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
    const artifacts = await getAllArtifacts((id) => seenArtifacts.delete(id));
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

  // ── Static file serving for /artifacts/ ──
  if (url.startsWith("/artifacts/")) {
    const urlPath = url.split("?")[0]; // Strip query params
    const relativePath = urlPath.slice("/artifacts/".length);
    const filePath = join(ARTIFACTS_DIR, relativePath);

    // Security: prevent path traversal
    if (!filePath.startsWith(ARTIFACTS_DIR)) {
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
      res.end(injectBridge(html));
    } else if (ext === ".html" || ext === ".htm") {
      const raw = readFileSync(filePath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(injectBridge(raw));
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
