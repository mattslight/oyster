import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, mkdirSync, statSync, copyFileSync, readdirSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, dirname, sep } from "node:path";
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
import { runStartupBackup } from "./backup.js";
import {
  generatePrompt,
  parseImportPayload,
  buildImportPlan,
  executeImportPlan,
  getPlan,
  setImportStatePath,
  type PromptContext,
  type PreviewDeps,
  type ExecuteDeps,
} from "./import.js";
import {
  spawnOpenCodeServe,
  getOpenCodePort,
  markShuttingDown,
  killOpenCode,
  startAutoApprover,
  proxyToOpenCode,
  proxySSE,
} from "./opencode-manager.js";
import { spawnSession, attachWebSocket } from "./pty-manager.js";
import { createMcpServer } from "./mcp-server.js";
import { SqliteFtsMemoryProvider } from "./memory-store.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ── Config ──

const isInstalledPackage = !!process.env.OYSTER_INSTALLED;
const PREFERRED_PORT = parseInt(process.env.OYSTER_PORT ?? (isInstalledPackage ? "4444" : "3333"), 10);
const OPENCODE_PORT = parseInt(process.env.OYSTER_OPENCODE_PORT ?? "0", 10);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Find the package root by walking up from __dirname until we find .opencode/agents/
function findPackageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".opencode", "agents"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd().replace(/[\\/]server[\\/]?$/, "");
}

const PACKAGE_ROOT = findPackageRoot();
// OpenCode binary: walk up from PACKAGE_ROOT to find node_modules/.bin/opencode (handles npm hoisting)
function findOpenCodeBin(): string {
  const isWin = process.platform === "win32";
  const names = isWin ? ["opencode.cmd", "opencode.ps1", "opencode"] : ["opencode"];
  const roots = [
    join(PACKAGE_ROOT, "server", "node_modules", ".bin"),
    join(PACKAGE_ROOT, "node_modules", ".bin"),
  ];
  // Walk up for hoisted installs (npx, global)
  let dir = PACKAGE_ROOT;
  for (let i = 0; i < 5; i++) {
    roots.push(join(dir, "node_modules", ".bin"));
    dir = dirname(dir);
  }
  for (const root of roots) {
    for (const name of names) {
      const candidate = join(root, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "opencode"; // fallback to PATH
}
const OPENCODE_BIN = findOpenCodeBin();
const SHELL = process.env.OYSTER_SHELL || OPENCODE_BIN;
const SHELL_ARGS = SHELL.endsWith("opencode") ? ["."] : [];
const WORKSPACE = process.env.OYSTER_WORKSPACE || PACKAGE_ROOT;
const PROJECT_ROOT = PACKAGE_ROOT;
// Installed → ~/.oyster/userland, dev → ./userland
const USERLAND_DIR = process.env.OYSTER_USERLAND || (isInstalledPackage ? join(homedir(), ".oyster", "userland") : join(PACKAGE_ROOT, "userland"));
const ARTIFACTS_DIR = join(USERLAND_DIR, "")  + sep;

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

// ── Auto-backup userland before bootstrap/upgrade and before touching the DB ──
runStartupBackup(USERLAND_DIR);
setImportStatePath(USERLAND_DIR);

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
const memoryProvider = new SqliteFtsMemoryProvider(USERLAND_DIR);
await memoryProvider.init();

// ── Initialize subsystems ──

const iconGenerator = new IconGenerator(updateGeneratedArtifact);
const pendingReveals = new Set<string>();

spawnSession(SHELL, SHELL_ARGS, WORKSPACE, cleanEnv);

// OpenCode spawn is deferred until after port resolution (see below)
scanExistingArtifacts(ARTIFACTS_DIR, iconGenerator);

// Reconcile non-builtin ready gen: artifacts into DB (idempotent — dedupes by canonical path).
// Load the archived-paths set once and pass it through; otherwise every
// reconcile call would re-run the same SQL + JSON.parse over every archived row.
{
  const archivedPaths = artifactService.getArchivedFilePaths();
  for (const entry of getGeneratedArtifactEntries()) {
    if (!entry.builtin && entry.filePath && entry.status === "ready") {
      artifactService.reconcileGeneratedArtifact(entry, entry.filePath, USERLAND_DIR, archivedPaths);
    }
  }
}

startGenerationTimer(iconGenerator, (id, filePath, builtin) => {
  if (!builtin) {
    const entry = getGeneratedArtifactEntries().find(e => e.id === id);
    if (entry) artifactService.reconcileGeneratedArtifact(entry, filePath, USERLAND_DIR);
  }
});
startAutoApprover(getOpenCodePort, (file) => handleFileEdited(file, ARTIFACTS_DIR, iconGenerator));

process.on("SIGTERM", () => { markShuttingDown(); killOpenCode(); db.close(); memoryProvider.close(); process.exit(0); });
process.on("SIGINT", () => { markShuttingDown(); killOpenCode(); db.close(); memoryProvider.close(); process.exit(0); });
process.on("uncaughtException", (err) => {
  console.error(`[oyster] uncaught exception: ${err.message}`);
});
process.on("unhandledRejection", (err) => {
  console.error(`[oyster] unhandled rejection: ${err instanceof Error ? err.message : err}`);
});

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

  // ── Artifact mutations (context-menu actions on the desktop) ──
  // PATCH /api/artifacts/:id   — rename and/or move to/from a group
  // POST  /api/artifacts/:id/archive — soft-delete (removed_at set)
  // PATCH /api/groups          — rename a group across all artifacts in a space
  // POST  /api/groups/archive  — archive all artifacts in a group

  const sendJson = (data: unknown, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  // Mutation endpoints below only accept tiny config bodies ({label, group_name}
  // etc). Cap at 64 KB to prevent memory/CPU abuse from an oversized payload.
  const MAX_MUTATION_BODY = 64_000;
  async function readJsonBody(): Promise<Record<string, unknown>> {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_MUTATION_BODY) {
        res.writeHead(413);
        res.end("Payload too large");
        req.destroy();
        throw new Error("Payload too large");
      }
    }
    if (!body) return {};
    try { return JSON.parse(body) as Record<string, unknown>; }
    catch { throw new Error("Invalid JSON body"); }
  }
  // Mutation endpoints are localhost-only. A browser tab on some other site
  // could otherwise POST to http://localhost:<port>/api/… and trigger
  // destructive actions (localhost CSRF). Mirrors the /mcp handler pattern:
  // reject non-local origins outright; echo the origin back for local ones
  // to override the wildcard CORS header set at the top of this handler.
  const rejectIfNonLocalOrigin = (): boolean => {
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      sendJson({ error: "Forbidden origin" }, 403);
      return true;
    }
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    return false;
  };

  // GET /api/artifacts/archived — list soft-deleted rows for the Archived view.
  // Must match BEFORE the :id-scoped routes below so "archived" is never
  // interpreted as an artifact id (e.g. PATCH /api/artifacts/archived
  // would otherwise hit the rename handler with id="archived"). Locked to
  // local origins for the same reason the mutation endpoints are — the
  // list contains user-private artifact metadata.
  if (url === "/api/artifacts/archived" && req.method === "GET") {
    if (rejectIfNonLocalOrigin()) return;
    try {
      const archived = await artifactService.getArchivedArtifacts();
      sendJson(archived);
    } catch (err) {
      sendJson({ error: (err as Error).message }, 500);
    }
    return;
  }

  const artifactMatch = url.match(/^\/api\/artifacts\/([^/]+)$/);
  if (artifactMatch && req.method === "PATCH") {
    if (rejectIfNonLocalOrigin()) return;
    const id = decodeURIComponent(artifactMatch[1]);
    try {
      const body = await readJsonBody();
      const fields: { label?: string; group_name?: string | null } = {};
      if ("label" in body) {
        if (typeof body.label === "string") {
          fields.label = body.label;
        } else {
          throw new Error("label must be a string");
        }
      }
      if ("group_name" in body) {
        const v = body.group_name;
        if (v === null) {
          fields.group_name = null;
        } else if (typeof v === "string") {
          fields.group_name = v.trim() || null;
        } else {
          throw new Error("group_name must be a string or null");
        }
      }
      const updated = await artifactService.updateArtifact(id, fields);
      sendJson(updated);
    } catch (err) {
      sendJson({ error: (err as Error).message }, 400);
    }
    return;
  }

  const restoreMatch = url.match(/^\/api\/artifacts\/([^/]+)\/restore$/);
  if (restoreMatch && req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return;
    const id = decodeURIComponent(restoreMatch[1]);
    try {
      artifactService.restoreArtifact(id);
      sendJson({ id, restored: true });
    } catch (err) {
      sendJson({ error: (err as Error).message }, 400);
    }
    return;
  }

  const archiveMatch = url.match(/^\/api\/artifacts\/([^/]+)\/archive$/);
  if (archiveMatch && req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return;
    const id = decodeURIComponent(archiveMatch[1]);
    try {
      artifactService.removeArtifact(id);
      sendJson({ id, archived: true });
    } catch (err) {
      sendJson({ error: (err as Error).message }, 400);
    }
    return;
  }

  if (url === "/api/groups" && req.method === "PATCH") {
    if (rejectIfNonLocalOrigin()) return;
    try {
      const body = await readJsonBody();
      const spaceId = typeof body.space_id === "string" ? body.space_id : null;
      const oldName = typeof body.old_name === "string" ? body.old_name : null;
      const newName = typeof body.new_name === "string" ? body.new_name : null;
      if (!spaceId || !oldName || !newName) {
        sendJson({ error: "space_id, old_name, new_name are required" }, 400);
        return;
      }
      const updated = artifactService.renameGroup(spaceId, oldName, newName);
      sendJson({ space_id: spaceId, old_name: oldName, new_name: newName.trim(), updated });
    } catch (err) {
      sendJson({ error: (err as Error).message }, 400);
    }
    return;
  }

  // POST /api/plugins/:id/uninstall — remove the plugin folder from userland.
  // The artifact detector + getAllArtifacts self-heal the in-memory and DB
  // entries; no separate cleanup needed here. Mirrors `oyster uninstall <id>`.
  const pluginUninstallMatch = url.match(/^\/api\/plugins\/([^/]+)\/uninstall$/);
  if (pluginUninstallMatch && req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return;
    const id = decodeURIComponent(pluginUninstallMatch[1]);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      sendJson({ error: `Invalid plugin id '${id}'` }, 400);
      return;
    }
    const dir = join(USERLAND_DIR, id);
    if (!existsSync(dir)) {
      sendJson({ error: `'${id}' is not installed` }, 404);
      return;
    }
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) {
      sendJson({ error: `${dir} has no manifest.json — refusing to remove a non-plugin folder` }, 400);
      return;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
      sendJson({ id, uninstalled: true });
    } catch (err) {
      sendJson({ error: (err as Error).message }, 500);
    }
    return;
  }

  if (url === "/api/groups/archive" && req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return;
    try {
      const body = await readJsonBody();
      const spaceId = typeof body.space_id === "string" ? body.space_id : null;
      const name = typeof body.name === "string" ? body.name : null;
      if (!spaceId || !name) {
        sendJson({ error: "space_id and name are required" }, 400);
        return;
      }
      const archived = artifactService.archiveGroup(spaceId, name);
      sendJson({ space_id: spaceId, name, archived });
    } catch (err) {
      sendJson({ error: (err as Error).message }, 400);
    }
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
    await proxySSE(req, res, "/event", getOpenCodePort());
    return;
  }

  if (url === "/api/chat/doc") {
    await proxyToOpenCode(req, res, "/doc", getOpenCodePort());
    return;
  }

  if (url === "/api/chat/session" && req.method === "POST") {
    await proxyToOpenCode(req, res, "/session", getOpenCodePort());
    return;
  }

  if (url === "/api/chat/session" && req.method === "GET") {
    await proxyToOpenCode(req, res, "/session", getOpenCodePort());
    return;
  }

  const msgMatch = url.match(/^\/api\/chat\/session\/([^/]+)\/message$/);
  if (msgMatch && (req.method === "POST" || req.method === "GET")) {
    await proxyToOpenCode(req, res, `/session/${msgMatch[1]}/message`, getOpenCodePort());
    return;
  }

  const sessionMatch = url.match(/^\/api\/chat\/session\/([^/]+)$/);
  if (sessionMatch && req.method === "GET") {
    await proxyToOpenCode(req, res, `/session/${sessionMatch[1]}`, getOpenCodePort());
    return;
  }

  const abortMatch = url.match(/^\/api\/chat\/session\/([^/]+)\/abort$/);
  if (abortMatch && req.method === "POST") {
    await proxyToOpenCode(req, res, `/session/${abortMatch[1]}/abort`, getOpenCodePort());
    return;
  }

  if (url === "/api/chat/permission" && req.method === "GET") {
    await proxyToOpenCode(req, res, "/permission", getOpenCodePort());
    return;
  }

  const questionMatch = url.match(/^\/api\/chat\/question\/([^/]+)\/reply$/);
  if (questionMatch && req.method === "POST") {
    await proxyToOpenCode(req, res, `/question/${questionMatch[1]}/reply`, getOpenCodePort());
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

  // ── Import routes ──

  if (url.startsWith("/api/import/prompt") && req.method === "GET") {
    const params = new URL(url, "http://localhost").searchParams;
    const provider = params.get("provider") || "chatgpt";
    const spaceId = params.get("spaceId");

    const allSpaces = spaceStore.getAll()
      .filter((s) => s.id !== "home" && s.id !== "__all__")
      .map((s) => ({ id: s.id, displayName: s.display_name }));

    const knownProjects = new Map<string, string[]>();
    for (const s of allSpaces) {
      const artifacts = store.getBySpaceId(s.id)
        .filter((a) => a.source_ref?.startsWith("import:") && !a.removed_at);
      if (artifacts.length > 0) {
        knownProjects.set(s.id, artifacts.map((a) => a.label));
      }
    }

    const targetSpace = spaceId
      ? allSpaces.find((s) => s.id === spaceId) ?? undefined
      : undefined;

    const prompt = generatePrompt({ provider, spaces: allSpaces, knownProjects, targetSpace });
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(prompt);
    return;
  }

  if (url === "/api/import/preview" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk;
      if (body.length > 500_000) { res.writeHead(413); res.end("Payload too large"); req.destroy(); }
    });
    req.on("end", async () => {
      try {
        const { raw, provider, targetSpaceId } = JSON.parse(body) as { raw: string; provider: string; targetSpaceId?: string };

        const convertFn = async (text: string): Promise<string | null> => {
          try {
            const port = getOpenCodePort();
            if (!port) {
              console.log("[import] OpenCode not ready yet");
              return null;
            }

            const sessRes = await fetch(`http://localhost:${port}/session`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            });
            const sess = await sessRes.json() as { id: string };
            console.log("[import] OpenCode session:", sess.id);

            const prompt = `Convert this text into valid JSON. Output ONLY the raw JSON object, nothing else. No markdown fences. No explanation.\n\nRequired schema:\n{\n  "schema_version": 1,\n  "mode": "fresh" | "augment",\n  "source": { "provider": "string", "generated_at": "ISO string" },\n  "spaces": [{ "name": "string", "projects": [{ "name": "string", "summary": "string" }] }],\n  "summaries": [{ "space": "string", "title": "string", "content": "string" }],\n  "memories": [{ "content": "string", "tags": ["string"], "space": "string" }]\n}\n\nText to convert:\n${text.slice(0, 12000)}`;

            const msgRes = await fetch(`http://localhost:${port}/session/${sess.id}/message`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ parts: [{ type: "text", text: prompt }], agent: "oyster" }),
            });

            const resBody = await msgRes.json() as {
              info?: { error?: unknown };
              parts?: Array<{ type: string; text?: string }>;
            };

            if (resBody.info?.error) {
              console.error("[import] OpenCode error:", JSON.stringify(resBody.info.error).slice(0, 300));
              return null;
            }

            for (const part of resBody.parts ?? []) {
              if (part.type === "text" && part.text?.includes("{")) {
                console.log("[import] AI conversion succeeded, length:", part.text.length);
                return part.text;
              }
            }
            console.log("[import] OpenCode returned", resBody.parts?.length ?? 0, "parts, none with JSON");
          } catch (err) {
            console.error("[import] AI conversion failed:", err);
          }
          return null;
        };

        const parseResult = await parseImportPayload(raw, convertFn);
        if (!parseResult.success || !parseResult.payload) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: parseResult.error }));
          return;
        }

        const generatedAt = parseResult.payload.source?.generated_at || new Date().toISOString();

        const previewDeps: PreviewDeps = {
          getSpaceBySlug: (slug) => {
            const row = spaceStore.getAll().find((s) => s.id === slug);
            return row ? { id: row.id, displayName: row.display_name } : null;
          },
          getArtifactsBySpace: (spaceId) => {
            return store.getBySpaceId(spaceId)
              .filter((a) => !a.removed_at)
              .map((a) => ({ source_ref: a.source_ref, label: a.label }));
          },
          findMemory: (content, spaceId) => {
            return memoryProvider.findExact(content, spaceId ?? undefined);
          },
        };

        const plan = buildImportPlan(parseResult.payload, provider, generatedAt, previewDeps, targetSpaceId);
        if (plan.actions.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Nothing found to import. Make sure you pasted the AI's response, not the prompt you sent it." }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(plan));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    return;
  }

  if (url === "/api/import/execute" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk;
      if (body.length > 100_000) { res.writeHead(413); res.end("Payload too large"); req.destroy(); }
    });
    req.on("end", async () => {
      try {
        const { plan_id, approved_action_ids } = JSON.parse(body) as {
          plan_id: string;
          approved_action_ids: string[];
        };

        if (!getPlan(plan_id)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Plan not found or expired" }));
          return;
        }

        const executeDeps: ExecuteDeps = {
          createSpace: (name) => spaceService.createSpace({ name }),
          createArtifact: (params) => artifactService.createArtifact(params, USERLAND_DIR),
          remember: (input) => memoryProvider.remember(input),
          findMemory: (content, spaceId) => memoryProvider.findExact(content, spaceId ?? undefined),
          getSpaceBySlug: (slug) => {
            const row = spaceStore.getAll().find((s) => s.id === slug);
            return row ? { id: row.id } : null;
          },
        };

        const result = await executeImportPlan(plan_id, approved_action_ids, executeDeps);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    return;
  }

  // ── No-op OAuth for MCP SDK (localhost only, no real auth) ──

  const BASE = `http://localhost:${PREFERRED_PORT}`;
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
    res.setHeader("Access-Control-Allow-Origin", origin || `http://localhost:${PREFERRED_PORT}`);

    const mcpServer = createMcpServer({ store, service: artifactService, userlandDir: USERLAND_DIR, iconGenerator, spaceService, memoryProvider, pendingReveals, broadcastUiEvent });
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
    const urlPath = decodeURIComponent((url || "/").split("?")[0]).replace(/^\/+/, "");
    const resolved = join(webDistDir, urlPath);
    // Security: prevent path traversal
    if (!resolved.startsWith(webDistDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    const candidates = [
      resolved,
      join(webDistDir, "index.html"), // SPA fallback
    ];
    for (const candidate of candidates) {
      if (candidate.startsWith(webDistDir) && existsSync(candidate) && statSync(candidate).isFile()) {
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

function findPort(preferred: number, maxAttempts = 10): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    function tryPort(port: number) {
      const testServer = createServer();
      testServer.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempt < maxAttempts) {
          attempt++;
          console.log(`  Port ${port} in use, trying ${port + 1}...`);
          tryPort(port + 1);
        } else {
          reject(new Error(`No available port found (tried ${preferred}-${port})`));
        }
      });
      testServer.listen(port, () => {
        testServer.close(() => resolve(port));
      });
    }
    tryPort(preferred);
  });
}

const port = await findPort(PREFERRED_PORT);

// Write OpenCode config with the actual port so MCP URL is always correct
const opencodeConfig = readFileSync(join(PROJECT_ROOT, ".opencode", "config.toml"), "utf8")
  .replace(/# MCP config is written dynamically.*/, "")
  .trimEnd()
  + `\n\n[mcp.oyster]\ntype = "remote"\nurl = "http://localhost:${port}/mcp/"\n`;
writeFileSync(join(USERLAND_DIR, ".opencode", "config.toml"), opencodeConfig);

// Also write opencode.json (OpenCode reads this from cwd)
const sourceOpencode = JSON.parse(readFileSync(join(PROJECT_ROOT, "opencode.json"), "utf8"));
sourceOpencode.mcp = { oyster: { type: "remote", url: `http://localhost:${port}/mcp/` } };
writeFileSync(join(USERLAND_DIR, "opencode.json"), JSON.stringify(sourceOpencode, null, 2) + "\n");

const httpServer = createServer(handleHttpRequest);
attachWebSocket(httpServer);

httpServer.listen(port, () => {
  console.log(`Oyster server listening on http://localhost:${port}`);
  console.log(`  WebSocket: ws://localhost:${port}`);
  console.log(`  API:       http://localhost:${port}/api/artifacts`);

  // Spawn OpenCode AFTER server is listening so MCP connection succeeds
  spawnOpenCodeServe(OPENCODE_BIN, OPENCODE_PORT, USERLAND_DIR, cleanEnv);
});
