import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, mkdirSync, statSync, copyFileSync, readdirSync, cpSync } from "node:fs";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import {
  startApp,
  stopApp,
  isPortOpen,
  waitForReady,
  updateGeneratedArtifact,
  getGeneratedArtifactEntries,
} from "./process-manager.js";
import { initDb } from "./db.js";
import { SqliteArtifactStore } from "./artifact-store.js";
import { ArtifactService } from "./artifact-service.js";
import { SqliteSpaceStore } from "./space-store.js";
import { SpaceService } from "./space-service.js";
import { IconGenerator } from "./icon-generator.js";
import { injectBridge } from "./error-bridge.js";
import {
  scanExistingArtifacts,
  startGenerationTimer,
  handleFileEdited,
  clearSeenArtifact,
  inferName,
} from "./artifact-detector.js";
import {
  spawnOpenCodeServe,
  markShuttingDown,
  startAutoApprover,
  proxyToOpenCode,
  proxySSE,
} from "./opencode-manager.js";
import { spawnSession, attachWebSocket } from "./pty-manager.js";
import { createMcpServer } from "./mcp-server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ── Config ──

const PORT = 4200;
const OPENCODE_PORT = 4096;
const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENCODE_BIN = join(__dirname, "..", "node_modules", ".bin", "opencode");
const SHELL = process.env.OYSTER_SHELL || OPENCODE_BIN;
const SHELL_ARGS = SHELL.endsWith("opencode") ? ["."] : [];
const WORKSPACE = process.env.OYSTER_WORKSPACE || process.cwd();
const PROJECT_ROOT = WORKSPACE.replace(/\/server\/?$/, "");
const USERLAND_DIR = process.env.OYSTER_USERLAND || `${PROJECT_ROOT}/userland`;
const ARTIFACTS_DIR = `${USERLAND_DIR}/`;

// ── MIME types ──

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".md": "text/html",
  ".mmd": "text/html",
  ".mermaid": "text/html",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

// ── Bootstrap ──

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

  syncIfNewer(
    `${PROJECT_ROOT}/.opencode/agents/oyster.md`,
    `${USERLAND_DIR}/.opencode/agents/oyster.md`,
  );
  syncIfNewer(
    `${PROJECT_ROOT}/.opencode/config.toml`,
    `${USERLAND_DIR}/.opencode/config.toml`,
  );

  // Seed built-in artifacts into userland on first install (copy-if-absent — no overwrite)
  const builtinsDir = join(PROJECT_ROOT, "builtins");
  if (existsSync(builtinsDir)) {
    for (const entry of readdirSync(builtinsDir)) {
      const dest = join(USERLAND_DIR, entry);
      if (!existsSync(dest)) {
        cpSync(join(builtinsDir, entry), dest, { recursive: true });
        console.log(`[bootstrap] installed built-in: ${entry}`);
      }
    }
  }
}

bootstrapUserland();

// ── Clean environment (no OpenAI key leak to subprocesses) ──

const cleanEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) cleanEnv[k] = v;
}
delete cleanEnv["OPENAI_API_KEY"];

// ── Artifact store ──

const db = initDb(USERLAND_DIR);
const store = new SqliteArtifactStore(db);
const artifactService = new ArtifactService(store, USERLAND_DIR);
const spaceStore = new SqliteSpaceStore(db);
const spaceService = new SpaceService(spaceStore, store);

// ── Initialize subsystems ──

const iconGenerator = new IconGenerator(updateGeneratedArtifact);

spawnSession(SHELL, SHELL_ARGS, WORKSPACE, cleanEnv);
spawnOpenCodeServe(OPENCODE_BIN, OPENCODE_PORT, USERLAND_DIR, cleanEnv);
scanExistingArtifacts(ARTIFACTS_DIR, iconGenerator);

// Reconcile non-builtin ready gen: artifacts into DB (idempotent — dedupes by canonical path)
for (const entry of getGeneratedArtifactEntries()) {
  if (!entry.builtin && entry.filePath && entry.status === "ready") {
    artifactService.reconcileGeneratedArtifact(entry, entry.filePath, USERLAND_DIR);
  }
}

startGenerationTimer(iconGenerator, (id, filePath, builtin) => {
  if (!builtin) {
    const entry = getGeneratedArtifactEntries().find(e => e.id === id);
    if (entry) artifactService.reconcileGeneratedArtifact(entry, filePath, USERLAND_DIR);
  }
});
startAutoApprover(OPENCODE_PORT, (file) => handleFileEdited(file, ARTIFACTS_DIR, iconGenerator));

process.on("SIGTERM", () => { markShuttingDown(); db.close(); process.exit(0); });
process.on("SIGINT", () => { markShuttingDown(); db.close(); process.exit(0); });

// ── Markdown rendering ──

const MD_STYLES = `
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
`.trim();

function renderMarkdown(name: string, content: string): string {
  const rendered = marked(content);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${name}</title><style>\n${MD_STYLES}\n</style></head><body>${rendered}</body></html>`;
}

function normalizeMermaidSource(content: string): string {
  let normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

  // Strip YAML frontmatter (--- ... ---), allowing leading whitespace and CRLF input.
  normalized = normalized.replace(/^\s*---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "");

  // Unwrap markdown fenced blocks
  const fenced = normalized.match(/^\s*```mermaid\s*\n([\s\S]*?)\n```\s*$/i);
  if (fenced) {
    normalized = fenced[1];
  }

  // Some diagrams are stored inside a fenced block that itself contains frontmatter.
  normalized = normalized.replace(/^\s*---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "");

  // Strip leading %% comment lines before the diagram type declaration.
  // Mermaid v11 can misparse %% comments that precede the diagram keyword.
  normalized = normalized.replace(/^(\s*%%[^\n]*\n)+/, "");

  return normalized.trim();
}

function renderMermaid(name: string, content: string): string {
  const normalized = normalizeMermaidSource(content);
  const escaped = normalized.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${name}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; background: #ffffff; }
#container { width: 100%; height: 100%; cursor: grab; visibility: hidden; }
#container.ready { visibility: visible; }
#container:active { cursor: grabbing; }
#container .mermaid svg { display: block; }
#raw-view {
  display: none; position: fixed; inset: 0; z-index: 200;
  background: #1e1e2e; overflow: auto;
}
#raw-view pre {
  margin: 0; padding: 24px; color: #cdd6f4; font: 13px/1.6 'IBM Plex Mono', 'SF Mono', Menlo, monospace;
  white-space: pre-wrap; word-wrap: break-word;
}
#raw-view .copy-btn {
  position: fixed; top: 16px; right: 16px; z-index: 201;
  padding: 6px 14px; border: none; border-radius: 6px;
  background: rgba(255,255,255,0.12); color: #cdd6f4;
  font: 13px/1 system-ui; cursor: pointer;
}
#raw-view .copy-btn:hover { background: rgba(255,255,255,0.2); }
.controls {
  position: fixed; bottom: 20px; right: 20px; display: flex; gap: 4px;
  background: rgba(0,0,0,0.7); border-radius: 8px; padding: 4px; z-index: 100;
}
.controls button {
  width: 32px; height: 32px; border: none; background: transparent;
  color: #fff; font-size: 18px; cursor: pointer; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
}
.controls button:hover { background: rgba(255,255,255,0.15); }
.controls .raw-toggle {
  width: auto; padding: 0 10px; font-size: 11px; font-weight: 600;
  letter-spacing: 0.04em; text-transform: uppercase;
}
.controls .divider { width: 1px; background: rgba(255,255,255,0.2); margin: 4px 2px; }
</style>
<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
import panzoom from 'https://cdn.jsdelivr.net/npm/panzoom@9.4.3/+esm';

mermaid.initialize({ startOnLoad: false, theme: 'default' });

const el = document.querySelector('.mermaid');
const rawSource = el.textContent.trim();
const { svg } = await mermaid.render('diagram', rawSource);
el.innerHTML = svg;

const container = document.getElementById('container');
const svgEl = el.querySelector('svg');

if (svgEl) {
  svgEl.removeAttribute('width');
  svgEl.removeAttribute('height');
  svgEl.style.width = 'max-content';
  svgEl.style.height = 'max-content';
}

const pz = panzoom(container, { smoothScroll: false, zoomDoubleClickSpeed: 1 });

function fitToScreen() {
  if (!svgEl) return;
  const pad = 40;
  const vw = window.innerWidth - pad * 2;
  const vh = window.innerHeight - pad * 2;
  const rect = svgEl.getBoundingClientRect();
  const t = pz.getTransform();
  const sw = rect.width / t.scale;
  const sh = rect.height / t.scale;
  const scale = Math.min(vw / sw, vh / sh);
  const cx = (window.innerWidth - sw * scale) / 2;
  const cy = (window.innerHeight - sh * scale) / 2;
  pz.zoomAbs(0, 0, scale);
  pz.moveTo(cx, cy);
}

fitToScreen();
container.classList.add('ready');

document.getElementById('zoom-in').onclick = () => pz.smoothZoom(window.innerWidth/2, window.innerHeight/2, 1.3);
document.getElementById('zoom-out').onclick = () => pz.smoothZoom(window.innerWidth/2, window.innerHeight/2, 0.7);
document.getElementById('zoom-fit').onclick = fitToScreen;

// Raw toggle
const rawView = document.getElementById('raw-view');
const rawPre = document.getElementById('raw-source');
const rawToggle = document.getElementById('raw-toggle');
const copyBtn = document.getElementById('copy-btn');
rawPre.textContent = rawSource;
let showingRaw = false;

rawToggle.onclick = () => {
  showingRaw = !showingRaw;
  rawView.style.display = showingRaw ? 'block' : 'none';
  rawToggle.textContent = showingRaw ? 'Diagram' : 'Raw';
};

copyBtn.onclick = () => {
  navigator.clipboard.writeText(rawSource).then(() => {
    copyBtn.textContent = 'Copied!';
    setTimeout(() => copyBtn.textContent = 'Copy', 1500);
  });
};
</script>
</head>
<body>
<div id="container">
<pre class="mermaid">
${escaped}
</pre>
</div>
<div id="raw-view">
  <button class="copy-btn" id="copy-btn">Copy</button>
  <pre id="raw-source"></pre>
</div>
<div class="controls">
  <button id="raw-toggle" class="raw-toggle" title="Toggle raw source">Raw</button>
  <div class="divider"></div>
  <button id="zoom-in" title="Zoom in">+</button>
  <button id="zoom-out" title="Zoom out">&minus;</button>
  <button id="zoom-fit" title="Fit to screen">&#x2922;</button>
</div>
</body>
</html>`;
}

// ── HTTP request handler ──

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

  const url = req.url || "/";

  // GET /api/resolve-path?url=...  — resolve a serving URL to a filesystem path
  if (url.startsWith("/api/resolve-path")) {
    const params = new URL(url, "http://localhost").searchParams;
    const targetUrl = params.get("url") || "";

    let filePath: string | undefined;

    // /docs/:id → DB artifact with filesystem storage
    const docsMatch = targetUrl.match(/^\/docs\/([^/]+)$/);
    if (docsMatch) {
      filePath = artifactService.getDocFile(docsMatch[1]);
    }

    // /artifacts/... → userland directory
    if (!filePath && targetUrl.startsWith("/artifacts/")) {
      const relativePath = targetUrl.slice("/artifacts/".length).split("?")[0];
      const candidate = join(ARTIFACTS_DIR, relativePath);
      if (candidate.startsWith(ARTIFACTS_DIR) && existsSync(candidate)) {
        filePath = candidate;
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ filePath: filePath || null }));
    return;
  }

  // GET /api/artifacts
  if (url === "/api/artifacts") {
    const artifacts = await artifactService.getAllArtifacts((id) => clearSeenArtifact(id));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(artifacts));
    return;
  }

  // GET /api/apps/:name/start
  const startMatch = url.match(/^\/api\/apps\/([^/]+)\/start$/);
  if (startMatch) {
    const name = startMatch[1];
    const config = artifactService.getAppConfig(name);
    if (!config) {
      res.writeHead(404);
      res.end("Unknown app");
      return;
    }
    if (await isPortOpen(config.port)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "already_running" }));
      return;
    }
    startApp(name, config);
    try {
      await waitForReady(config.port);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "started", port: config.port }));
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
    const config = artifactService.getAppConfig(name);
    if (!config) {
      res.writeHead(404);
      res.end("Unknown app");
      return;
    }
    const stopped = stopApp(name, config.port);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: stopped ? "stopped" : "not_managed" }));
    return;
  }

  // GET /docs/:name
  const docsMatch = url.split("?")[0].match(/^\/docs\/([^/]+)$/);
  if (docsMatch) {
    const name = docsMatch[1];
    const filePath = artifactService.getDocFile(name);
    if (!filePath || !existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = extname(filePath);
    const mime = MIME[ext] || "application/octet-stream";

    if (ext === ".md") {
      const content = readFileSync(filePath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(renderMarkdown(name, content));
    } else if (ext === ".mmd" || ext === ".mermaid") {
      const content = readFileSync(filePath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(injectBridge(renderMermaid(name, content)));
    } else {
      res.writeHead(200, { "Content-Type": mime });
      res.end(readFileSync(filePath));
    }
    return;
  }

  // ── OpenCode chat API proxy ──

  if (req.method === "OPTIONS" && url.startsWith("/api/chat/")) {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (url === "/api/chat/events" || url.startsWith("/api/chat/events?")) {
    await proxySSE(req, res, "/event", OPENCODE_PORT);
    return;
  }

  if (url === "/api/chat/doc") {
    await proxyToOpenCode(req, res, "/doc", OPENCODE_PORT);
    return;
  }

  if (url === "/api/chat/session" && req.method === "POST") {
    await proxyToOpenCode(req, res, "/session", OPENCODE_PORT);
    return;
  }

  if (url === "/api/chat/session" && req.method === "GET") {
    await proxyToOpenCode(req, res, "/session", OPENCODE_PORT);
    return;
  }

  const msgMatch = url.match(/^\/api\/chat\/session\/([^/]+)\/message$/);
  if (msgMatch && (req.method === "POST" || req.method === "GET")) {
    await proxyToOpenCode(req, res, `/session/${msgMatch[1]}/message`, OPENCODE_PORT);
    return;
  }

  const sessionMatch = url.match(/^\/api\/chat\/session\/([^/]+)$/);
  if (sessionMatch && req.method === "GET") {
    await proxyToOpenCode(req, res, `/session/${sessionMatch[1]}`, OPENCODE_PORT);
    return;
  }

  const abortMatch = url.match(/^\/api\/chat\/session\/([^/]+)\/abort$/);
  if (abortMatch && req.method === "POST") {
    await proxyToOpenCode(req, res, `/session/${abortMatch[1]}/abort`, OPENCODE_PORT);
    return;
  }

  if (url === "/api/chat/permission" && req.method === "GET") {
    await proxyToOpenCode(req, res, "/permission", OPENCODE_PORT);
    return;
  }

  const questionMatch = url.match(/^\/api\/chat\/question\/([^/]+)\/reply$/);
  if (questionMatch && req.method === "POST") {
    await proxyToOpenCode(req, res, `/question/${questionMatch[1]}/reply`, OPENCODE_PORT);
    return;
  }

  // ── Static file serving for /artifacts/ ──
  if (url.startsWith("/artifacts/")) {
    const urlPath = url.split("?")[0];
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
      const name = inferName(filePath);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(injectBridge(renderMarkdown(name, content)));
    } else if (ext === ".mmd" || ext === ".mermaid") {
      const content = readFileSync(filePath, "utf8");
      const name = inferName(filePath);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(injectBridge(renderMermaid(name, content)));
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

  // ── Spaces API ──

  // GET /api/resolve-folder?name=... — search common dev dirs for a folder by name
  // Restricted to same-origin (localhost) — probes $HOME filesystem, must not be callable cross-origin
  if (url.startsWith("/api/resolve-folder") && req.method === "GET") {
    const origin = req.headers.origin;
    if (origin && !origin.startsWith("http://localhost") && !origin.startsWith("http://127.0.0.1")) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    const folderName = new URL(url, "http://localhost").searchParams.get("name") ?? "";
    if (!folderName) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "name is required" }));
      return;
    }
    const home = process.env.HOME ?? "";
    const searchRoots = [home, `${home}/Dev`, `${home}/dev`, `${home}/Projects`, `${home}/projects`,
      `${home}/code`, `${home}/Code`, `${home}/repos`, `${home}/Repos`, `${home}/Documents`, `${home}/Desktop`];
    const { existsSync, statSync } = await import("node:fs");
    const seenInodes = new Set<number>();
    const matches: string[] = [];
    for (const root of searchRoots) {
      const candidate = `${root}/${folderName}`;
      try {
        const st = statSync(candidate);
        if (st.isDirectory() && !seenInodes.has(st.ino)) {
          seenInodes.add(st.ino);
          matches.push(candidate);
        }
      } catch { /* skip */ }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ matches }));
    return;
  }

  // POST /api/spaces — create space
  if (url === "/api/spaces" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { name, repoPath } = JSON.parse(body);
        const space = spaceService.createSpace({ name, repoPath });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(space));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    return;
  }

  // GET /api/spaces — list spaces
  if (url === "/api/spaces" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(spaceService.listSpaces()));
    return;
  }

  // GET /api/spaces/:id  and  DELETE /api/spaces/:id
  const spaceIdMatch = url.match(/^\/api\/spaces\/([^/]+)$/);
  if (spaceIdMatch && req.method === "GET") {
    const space = spaceService.getSpace(spaceIdMatch[1]);
    if (!space) { res.writeHead(404); res.end("Space not found"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(space));
    return;
  }
  if (spaceIdMatch && req.method === "DELETE") {
    try {
      spaceService.deleteSpace(spaceIdMatch[1]);
      res.writeHead(204);
      res.end();
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // POST /api/spaces/:id/scan
  const spaceScanMatch = url.match(/^\/api\/spaces\/([^/]+)\/scan$/);
  if (spaceScanMatch && req.method === "POST") {
    spaceService.scanSpace(spaceScanMatch[1]).then((result) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    }).catch((err: Error) => {
      const status = err.message.includes("already in progress") ? 409 : 400;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // ── MCP server ──
  if (url === "/mcp" || url === "/mcp/") {
    // Localhost-only: reject non-local origins and don't emit wildcard CORS
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    // Override the wildcard CORS header set at the top of handleHttpRequest
    res.setHeader("Access-Control-Allow-Origin", origin || "http://localhost:4200");

    const mcpServer = createMcpServer({ store, service: artifactService, userlandDir: USERLAND_DIR, iconGenerator, spaceService });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); mcpServer.close(); });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  // Fallback
  res.writeHead(404);
  res.end("Not found");
}

// ── HTTP + WebSocket server ──

const httpServer = createServer(handleHttpRequest);
attachWebSocket(httpServer);

httpServer.listen(PORT, () => {
  console.log(`Oyster server listening on http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}`);
  console.log(`  API:       http://localhost:${PORT}/api/artifacts`);
});
