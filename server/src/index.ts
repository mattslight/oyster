import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, mkdirSync, statSync, copyFileSync, readdirSync, cpSync } from "node:fs";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown, renderMermaid } from "./renderers.js";
import { handleSpacesRequest } from "./spaces-routes.js";
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

// Find the package root by walking up from __dirname until we find .opencode/agents/
function findPackageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".opencode", "agents"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd().replace(/\/server\/?$/, "");
}

const PACKAGE_ROOT = findPackageRoot();
// OpenCode binary: walk up from PACKAGE_ROOT to find node_modules/.bin/opencode (handles npm hoisting)
function findOpenCodeBin(): string {
  const candidates = [
    join(PACKAGE_ROOT, "server", "node_modules", ".bin", "opencode"),
    join(PACKAGE_ROOT, "node_modules", ".bin", "opencode"),
  ];
  // Walk up for hoisted installs (npx, global)
  let dir = PACKAGE_ROOT;
  for (let i = 0; i < 5; i++) {
    candidates.push(join(dir, "node_modules", ".bin", "opencode"));
    dir = dirname(dir);
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "opencode"; // fallback to PATH
}
const OPENCODE_BIN = findOpenCodeBin();
const SHELL = process.env.OYSTER_SHELL || OPENCODE_BIN;
const SHELL_ARGS = SHELL.endsWith("opencode") ? ["."] : [];
const WORKSPACE = process.env.OYSTER_WORKSPACE || PACKAGE_ROOT;
const PROJECT_ROOT = PACKAGE_ROOT;
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
const pendingReveals = new Set<string>();

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

// ── UI push events (SSE) ──

interface UiCommand {
  version: 1;
  command: string;
  payload: unknown;
  correlationId?: string;
}

const uiClients = new Set<ServerResponse>();

function broadcastUiEvent(event: UiCommand) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of uiClients) {
    if (client.writableEnded || client.destroyed) {
      uiClients.delete(client);
      continue;
    }
    try {
      client.write(data);
    } catch {
      uiClients.delete(client);
    }
  }
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
    const revealed = new Set(pendingReveals);
    pendingReveals.clear();
    const response = artifacts.map((a) => revealed.has(a.id) ? { ...a, pendingReveal: true } : a);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }

  // GET /api/ui/events — SSE stream for UI commands
  if (url === "/api/ui/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    uiClients.add(res);
    req.on("close", () => uiClients.delete(res));
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

  if (await handleSpacesRequest(url, req, res, spaceService)) return;

  // ── No-op OAuth for MCP SDK (localhost only, no real auth) ──

  const BASE = `http://localhost:${PORT}`;
  const json = (res: ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  if (url === "/.well-known/oauth-protected-resource/mcp" || url === "/.well-known/oauth-protected-resource/mcp/") {
    json(res, { resource: `${BASE}/mcp`, authorization_servers: [`${BASE}/`], scopes_supported: [] });
    return;
  }
  if (url === "/.well-known/oauth-authorization-server") {
    json(res, {
      issuer: `${BASE}/`,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    });
    return;
  }
  if (url === "/oauth/register" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed: { client_name?: string };
    try { parsed = JSON.parse(body || "{}"); } catch { json(res, { error: "Invalid JSON body" }, 400); return; }
    json(res, { client_id: "oyster-local", client_name: parsed.client_name || "oyster", client_secret: "none", redirect_uris: ["http://localhost"] }, 201);
    return;
  }
  if (url?.startsWith("/oauth/authorize")) {
    const params = new URL(url, BASE).searchParams;
    const redirect = params.get("redirect_uri") || `${BASE}/`;
    const state = params.get("state") || "";
    const sep = redirect.includes("?") ? "&" : "?";
    res.writeHead(302, { Location: `${redirect}${sep}code=oyster-local-code&state=${state}` });
    res.end();
    return;
  }
  if (url === "/oauth/token" && req.method === "POST") {
    json(res, { access_token: "oyster-local-token", token_type: "bearer", expires_in: 86400 });
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

    const mcpServer = createMcpServer({ store, service: artifactService, userlandDir: USERLAND_DIR, iconGenerator, spaceService, pendingReveals, broadcastUiEvent });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); mcpServer.close(); });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  // ── Static web UI (production mode) ──
  // Check dist/public (published package) first, then web/dist (dev with build)
  const webDistDir = existsSync(join(__dirname, "..", "..", "public"))
    ? join(__dirname, "..", "..", "public")
    : join(PROJECT_ROOT, "web", "dist");
  if (existsSync(webDistDir)) {
    const urlPath = (url || "/").split("?")[0];
    const candidates = [
      join(webDistDir, urlPath),
      join(webDistDir, "index.html"), // SPA fallback
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        const ext = extname(candidate);
        const mime = MIME[ext] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime });
        res.end(readFileSync(candidate));
        return;
      }
    }
  }

  // Fallback — JSON body so MCP SDK OAuth discovery doesn't choke on plain text
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

// ── HTTP + WebSocket server ──

const httpServer = createServer(handleHttpRequest);
attachWebSocket(httpServer);

httpServer.listen(PORT, () => {
  console.log(`Oyster server listening on http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}`);
  console.log(`  API:       http://localhost:${PORT}/api/artifacts`);
});
