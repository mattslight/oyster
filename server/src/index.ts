import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, mkdirSync, statSync, copyFileSync } from "node:fs";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import {
  loadRegistry,
  getAllArtifacts,
  startApp,
  stopApp,
  isPortOpen,
  waitForReady,
  updateGeneratedArtifact,
} from "./process-manager.js";
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
}

bootstrapUserland();

// ── Clean environment (no OpenAI key leak to subprocesses) ──

const cleanEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) cleanEnv[k] = v;
}
delete cleanEnv["OPENAI_API_KEY"];

// ── Registry ──

const registry = loadRegistry();
const docsMap = new Map<string, string>();
for (const doc of registry.docs) {
  docsMap.set(doc.name, doc.file);
}

// ── Initialize subsystems ──

const iconGenerator = new IconGenerator(updateGeneratedArtifact);

spawnSession(SHELL, SHELL_ARGS, WORKSPACE, cleanEnv);
spawnOpenCodeServe(OPENCODE_BIN, OPENCODE_PORT, USERLAND_DIR, cleanEnv);
scanExistingArtifacts(ARTIFACTS_DIR, iconGenerator);
startGenerationTimer(iconGenerator);
startAutoApprover(OPENCODE_PORT, (file) => handleFileEdited(file, ARTIFACTS_DIR, iconGenerator));

process.on("SIGTERM", () => { markShuttingDown(); process.exit(0); });
process.on("SIGINT", () => { markShuttingDown(); process.exit(0); });

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

// ── HTTP request handler ──

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const url = req.url || "/";

  // GET /api/artifacts
  if (url === "/api/artifacts") {
    const artifacts = await getAllArtifacts((id) => clearSeenArtifact(id));
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
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(renderMarkdown(name, content));
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

const httpServer = createServer(handleHttpRequest);
attachWebSocket(httpServer);

httpServer.listen(PORT, () => {
  console.log(`Oyster server listening on http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}`);
  console.log(`  API:       http://localhost:${PORT}/api/artifacts`);
});
