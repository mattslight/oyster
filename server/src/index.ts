import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, mkdirSync, statSync, copyFileSync, readdirSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startApp,
  stopApp,
  isPortOpen,
  waitForReady,
  updateGeneratedArtifact,
  getGeneratedArtifactEntries,
  type ArtifactKind,
} from "./process-manager.js";
import Database from "better-sqlite3";
import { initDb } from "./db.js";
import { SqliteArtifactStore } from "./artifact-store.js";
import { SqliteSessionStore } from "./session-store.js";
import { ClaudeCodeWatcher } from "./watchers/claude-code.js";
import { ArtifactService } from "./artifact-service.js";
import { SqliteSpaceStore } from "./space-store.js";
import { SpaceService } from "./space-service.js";
import { slugify } from "./utils.js";
import { IconGenerator } from "./icon-generator.js";
import { makeRouteCtx } from "./http-utils.js";
import { tryHandleSessionRoute } from "./routes/sessions.js";
import { tryHandleArtifactRoute } from "./routes/artifacts.js";
import { tryHandleSpaceRoute } from "./routes/spaces.js";
import { tryHandleSetupRoute } from "./routes/setup.js";
import { tryHandleMemoryRoute } from "./routes/memories.js";
import { tryHandleAuthRoute } from "./routes/auth.js";
import { tryHandlePublishRoute } from "./routes/publish.js";
import { tryHandlePinRoute } from "./routes/pin.js";
import { createPublishService, PublishError } from "./publish-service.js";
import { hashPassword } from "./password-hash.js";
import { tryHandleOAuthMcpRoute } from "./routes/oauth-mcp.js";
import { tryHandleImportRoute } from "./routes/import.js";
import { tryHandleStaticRoute } from "./routes/static.js";
import { MIME } from "./mime.js";
import type { UiCommand } from "../../shared/types.js";
import {
  scanExistingArtifacts,
  startGenerationTimer,
  handleFileEdited,
  clearSeenArtifact,
} from "./artifact-detector.js";
import { runStartupBackup } from "./backup.js";
import { setImportStatePath } from "./import.js";
import {
  spawnOpenCodeServe,
  getOpenCodePort,
  markShuttingDown,
  killOpenCode,
  startAutoApprover,
  proxyToOpenCode,
} from "./opencode-manager.js";
import { attachChatEventClient } from "./opencode-events.js";
import { sweepOrphanOpenCodeProcesses } from "./opencode-orphan-sweep.js";
import { attachWebSocket } from "./pty-manager.js";
import { SqliteFtsMemoryProvider } from "./memory-store.js";
import { AuthService } from "./auth-service.js";
import { bootMark, bootTime, bootTimeAsync } from "./boot-timer.js";

bootMark("imports loaded");

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
// ── Oyster userland layout (#207) ──
//
//   OYSTER_HOME — the user's Oyster workspace root.
//     Installed → ~/Oyster/            (visible; migrated from ~/.oyster/userland/)
//     Dev       → ./userland/          (unchanged; feature-branch dev writes here)
//   DB_DIR      — oyster.db, memory.db. At OYSTER_HOME/db/.
//   APPS_DIR    — installed app bundles (builtins + community). At OYSTER_HOME/apps/.
//   SPACES_DIR  — one folder per user space. At OYSTER_HOME/spaces/.
//   CONFIG_DIR  — reserved for future Oyster-specific config.
//   BACKUPS_DIR — snapshots. At OYSTER_HOME/backups/.
//
// opencode-ai's own config (opencode.json, .opencode/) stays at OYSTER_HOME
// root because opencode discovers it via CWD walk-up; moving it would
// require a spawn-flag change out of scope for this PR.
const OYSTER_HOME = process.env.OYSTER_USERLAND || (isInstalledPackage ? join(homedir(), "Oyster") : join(PACKAGE_ROOT, "userland"));
const DB_DIR = join(OYSTER_HOME, "db");
const CONFIG_DIR = join(OYSTER_HOME, "config");
const APPS_DIR = join(OYSTER_HOME, "apps");
const SPACES_DIR = join(OYSTER_HOME, "spaces");
const BACKUPS_DIR = join(OYSTER_HOME, "backups");

// Retained for callsites that still pass the userland root down the stack
// (e.g. opencode-ai's spawn CWD, reconcileGeneratedArtifact's base path).
// Alias to OYSTER_HOME to minimise the surface of this PR.
const USERLAND_DIR = OYSTER_HOME;

// Dev handshake: write the actual bound port to userland/.dev-port so the
// Vite dev server proxies to *this* backend, not whichever Oyster happens
// to be on 3333. Each worktree has its own userland → its own file → no
// cross-talk. Removed on shutdown so a stale file fails loud (connection
// refused) rather than silent (talking to the wrong server). The pre-listen
// delete closes the race where wait-on would otherwise succeed against a
// crashed prior run's stale file. Declared up here (not next to listen())
// so the SIGTERM/SIGINT handlers registered below don't hit a const TDZ if
// a signal arrives mid-boot.
const DEV_PORT_FILE = join(USERLAND_DIR, ".dev-port");
function clearDevPortFile() {
  try { rmSync(DEV_PORT_FILE, { force: true }); } catch { /* best effort */ }
}

// Resolver for a space's native folder (where `create_artifact` writes).
// Every callsite that used to compute `join(USERLAND_DIR, space_id)` goes
// through this, so swapping to a first-class sources table later (#208) is
// a one-function change.
function getNativeSourcePath(spaceId: string): string {
  return join(SPACES_DIR, spaceId);
}

// For the watcher and scanExistingArtifacts, which walk a single directory
// looking for app-bundle folders. In the new layout, bundles live under
// APPS_DIR (installed) or SPACES_DIR/<space>/ (AI-generated). Both need to
// be scanned; see the callsites below.
const ARTIFACTS_DIR = join(OYSTER_HOME, "")  + sep;

// ── Bootstrap ──

function syncIfNewer(src: string, dest: string) {
  let shouldCopy = !existsSync(dest);
  if (!shouldCopy) {
    shouldCopy = statSync(src).mtimeMs > statSync(dest).mtimeMs;
  }
  if (shouldCopy) copyFileSync(src, dest);
}

function bootstrapUserland() {
  mkdirSync(OYSTER_HOME, { recursive: true });
  mkdirSync(DB_DIR, { recursive: true });
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(APPS_DIR, { recursive: true });
  mkdirSync(SPACES_DIR, { recursive: true });
  mkdirSync(BACKUPS_DIR, { recursive: true });
  mkdirSync(`${OYSTER_HOME}/.opencode/agents`, { recursive: true });

  syncIfNewer(
    `${PROJECT_ROOT}/.opencode/agents/oyster.md`,
    `${OYSTER_HOME}/.opencode/agents/oyster.md`,
  );
  syncIfNewer(
    `${PROJECT_ROOT}/.opencode/config.toml`,
    `${OYSTER_HOME}/.opencode/config.toml`,
  );

  // Drop a static README at the Oyster root so users browsing in
  // Finder / Explorer can orient themselves without starting the app.
  // This is deliberately static and broad (getting-started, shortcut
  // commands, layout hints). The in-app "Where do my files live?" builtin
  // shows the *live* per-install paths — different audience, different
  // content.
  const readmeSrc = join(PROJECT_ROOT, "assets", "oyster-home-readme.md");
  if (existsSync(readmeSrc)) {
    syncIfNewer(readmeSrc, `${OYSTER_HOME}/README.md`);
  }

  // Ensure a default "home" space folder exists so create_artifact can
  // always resolve a landing spot, even on a fresh install with no other
  // spaces created yet.
  mkdirSync(join(SPACES_DIR, "home"), { recursive: true });

  // Seed built-in app bundles into apps/. Always re-syncs from
  // `builtins/<name>/` because builtins are read-only by design — keeping
  // them in lockstep with the source is more important than the cost of a
  // few file copies on startup. A previous mtime / manifest-content check
  // missed asset-only changes (e.g. an index.html edit with no manifest
  // change) and shipped stale builtins. cpSync(recursive) overwrites files
  // present in source but doesn't delete extras in dest — generated icon.png
  // and other server-side artifacts survive.
  const builtinsDir = join(PROJECT_ROOT, "builtins");
  if (existsSync(builtinsDir)) {
    for (const entry of readdirSync(builtinsDir)) {
      const src = join(builtinsDir, entry);
      const dest = join(APPS_DIR, entry);
      const fresh = !existsSync(dest);
      cpSync(src, dest, { recursive: true });
      if (fresh) console.log(`[bootstrap] installed built-in: ${entry}`);
    }
  }
}

// ── Auto-backup userland before bootstrap/upgrade and before touching the DB ──
bootTime("runStartupBackup", () => runStartupBackup(OYSTER_HOME));
setImportStatePath(OYSTER_HOME);

bootTime("bootstrapUserland", () => bootstrapUserland());

// ── Clean environment (no OpenAI key leak to subprocesses) ──

const cleanEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) cleanEnv[k] = v;
}
delete cleanEnv["OPENAI_API_KEY"];

// ── Artifact store ──

const db = bootTime("initDb (migrations)", () => initDb(DB_DIR));
const store = new SqliteArtifactStore(db);
const spaceStore = new SqliteSpaceStore(db);
const sessionStore = new SqliteSessionStore(db);
const WORKER_BASE = process.env.OYSTER_AUTH_BASE
  ? process.env.OYSTER_AUTH_BASE.replace(/\/auth$/, "")
  : "https://oyster.to";

// artifactService reads the dedicated icons dir at `<root>/icons/<id>/icon.png`
// — that lives at OYSTER_HOME root (URL-addressable via /artifacts/icons/...),
// not inside DB_DIR. spaceStore is passed in so rowToArtifact can resolve the
// linked-source path for tiles whose `source_id` is non-null.
const artifactService = new ArtifactService(store, WORKER_BASE, OYSTER_HOME, spaceStore);

const spaceService = new SpaceService(spaceStore, store, artifactService, sessionStore);
const memoryProvider = new SqliteFtsMemoryProvider(DB_DIR);
await bootTimeAsync("memoryProvider.init", () => memoryProvider.init());

// Auth bridge to oyster.to/auth/*. Reads ~/Oyster/config/auth.json on
// startup so a previously-signed-in user is recognised across restarts.
// validatePersistedSession() then re-checks the cloud session in the
// background — clears local state if the cloud reports 401 (revoked
// elsewhere), keeps it if the cloud is unreachable.
const authService = new AuthService(CONFIG_DIR);
authService.onAuthChanged((state) => {
  broadcastUiEvent({
    version: 1,
    command: "auth_changed",
    payload: { user: state.user },
  });
});
void authService.validatePersistedSession();
const publishService = createPublishService({
  db,
  readArtifactBytes: async (artifactId) => {
    // ArtifactService.getDocFile resolves filesystem-backed artefacts to their
    // on-disk path. Returns undefined for non-filesystem storage (e.g. discovered
    // artefacts with only a manifest, app bundles, etc.) — those can't be
    // published as a single file.
    const path = artifactService.getDocFile(artifactId);
    if (!path) {
      throw new PublishError(400, "artifact_not_publishable",
        "This artefact has no single-file content to publish (only filesystem-backed artefacts are supported in 0.7.0).");
    }
    return new Uint8Array(readFileSync(path));
  },
  currentUser: () => {
    const u = authService.getState().user;
    return u ? { id: u.id, email: u.email, tier: u.tier } : null;
  },
  sessionToken: () => authService.getState().sessionToken,
  workerBase: WORKER_BASE,
  hashPassword,
  fetch,
});

// Refresh the local publish-state mirror whenever a user is signed in — at
// boot if loadFromDisk() rehydrated a session, and on every subsequent
// auth_changed transition. logBackfill always emits, even on {0,0}, so the
// dev log shows whether we ran and what happened (artefact-ID mismatches
// surface as `skipped` and would otherwise look like silence).
function logBackfill(label: string, result: { mirrored: number; skipped: number }): void {
  console.log(`[publish] ${label}: mirrored=${result.mirrored} skipped=${result.skipped}` +
    (result.skipped ? " (skipped → surfaced as cloud-only ghosts)" : ""));
  // Always broadcast — mirrored publications update local rows, skipped ones
  // populate the cloud-only ghost cache. Either way the surface needs a refetch.
  if (result.mirrored > 0 || result.skipped > 0) {
    broadcastUiEvent({ version: 1, command: "artifact_changed", payload: { id: null } });
  }
}

// Wire the cloud-only publication source into artifact-service so ghosts
// appear in /api/artifacts. Done after both services exist; the source
// itself is just a getter on publish-service.
artifactService.setCloudOnlyPublicationsSource(() => publishService.getCloudOnlyPublications());

authService.onAuthChanged((state) => {
  if (!state.user || !state.sessionToken) return;
  void publishService.backfillPublications().then((r) => logBackfill("auth-backfill", r));
});
if (authService.getState().user) {
  void publishService.backfillPublications().then((r) => logBackfill("startup-backfill", r));
}

// ── Initialize subsystems ──

const iconGenerator = new IconGenerator(updateGeneratedArtifact);
const pendingReveals = new Set<string>();

// PTY shell is lazy-spawned on first WebSocket connection (i.e. when the
// user opens the terminal window). Spawning eagerly here doubled boot time
// because two opencode-ai processes competed for CPU during init. See #385.

bootMark("subsystems init done (artifactService, spaceService, authService, publishService, iconGenerator)");

// OpenCode spawn is deferred until after port resolution (see below)
// Scan every location where app bundles can live after #207:
//   APPS_DIR               — installed builtins + community apps
//   SPACES_DIR/<space>/    — AI-generated apps owned by a space
//   OYSTER_HOME            — anything still at the root (legacy / newly-generated
//                            before the agent's CWD gets re-pointed in a follow-up)
bootTime("scanExistingArtifacts (apps + spaces + home)", () => {
  scanExistingArtifacts(APPS_DIR, iconGenerator);
  if (existsSync(SPACES_DIR)) {
    for (const spaceEntry of readdirSync(SPACES_DIR)) {
      const spaceDir = join(SPACES_DIR, spaceEntry);
      try {
        // manifestOnly: true — space folders contain organisational
        // subfolders (invoices/, research/) with many single-file artifacts.
        // The fallback scan would misregister each subfolder as a bogus
        // gen:<folder> bundle; only manifest-based AI-generated apps
        // should be picked up here.
        if (statSync(spaceDir).isDirectory()) scanExistingArtifacts(spaceDir, iconGenerator, { manifestOnly: true });
      } catch { /* skip unreadable */ }
    }
  }
  scanExistingArtifacts(ARTIFACTS_DIR, iconGenerator);
});

// Reconcile non-builtin ready gen: artifacts into DB (idempotent — dedupes by canonical path).
// Load the archived-paths set once and pass it through; otherwise every
// reconcile call would re-run the same SQL + JSON.parse over every archived row.
bootTime("reconcileGeneratedArtifacts", () => {
  const archivedPaths = artifactService.getArchivedFilePaths();
  for (const entry of getGeneratedArtifactEntries()) {
    if (!entry.builtin && entry.filePath && entry.status === "ready") {
      artifactService.reconcileGeneratedArtifact(entry, entry.filePath, USERLAND_DIR, archivedPaths);
    }
  }
});

startGenerationTimer(iconGenerator, (id, filePath, builtin) => {
  if (!builtin) {
    const entry = getGeneratedArtifactEntries().find(e => e.id === id);
    if (entry) artifactService.reconcileGeneratedArtifact(entry, filePath, USERLAND_DIR);
  }
});
startAutoApprover(getOpenCodePort, (file) => handleFileEdited(file, ARTIFACTS_DIR, iconGenerator));

process.on("SIGTERM", () => { markShuttingDown(); killOpenCode(); db.close(); memoryProvider.close(); clearDevPortFile(); process.exit(0); });
process.on("SIGINT", () => { markShuttingDown(); killOpenCode(); db.close(); memoryProvider.close(); clearDevPortFile(); process.exit(0); });
process.on("uncaughtException", (err) => {
  console.error(`[oyster] uncaught exception: ${err.message}`);
  markShuttingDown();
  try { killOpenCode(); } catch { /* best effort */ }
  // Fail fast — the server is in an unknown state with opencode-ai dead and
  // restart disabled. Exiting non-zero lets the user restart cleanly rather
  // than leaving a zombie that silently drops every chat message.
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error(`[oyster] unhandled rejection: ${err instanceof Error ? err.message : err}`);
  markShuttingDown();
  try { killOpenCode(); } catch { /* best effort */ }
  process.exit(1);
});

// ── UI push events (SSE) ──

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

  // Per-request response helpers (sendJson / sendError / readJsonBody /
  // rejectIfNonLocalOrigin). Live in http-utils.ts so route modules can
  // share them; HttpError is also exported there.
  const ctx = makeRouteCtx(req, res);
  const { sendJson, sendError, readJsonBody, rejectIfNonLocalOrigin } = ctx;

  // /api/sessions/* — first extracted route bucket. Returns true when
  // handled; falls through if no session route matched.
  if (await tryHandleSessionRoute(req, res, url, ctx, {
    sessionStore, spaceStore, artifactService, memoryProvider,
  })) return;

  // /api/artifacts/*, /api/groups/*, /api/plugins/:id/uninstall.
  if (await tryHandleArtifactRoute(req, res, url, ctx, {
    artifactService, sessionStore, iconGenerator, pendingReveals,
    clearSeenArtifact, OYSTER_HOME, APPS_DIR, SPACES_DIR,
  })) return;

  // /api/spaces/* — collapsed from the legacy spaces-routes.ts and the
  // inline /api/spaces/:id/sources* + /api/spaces/from-path handlers.
  if (await tryHandleSpaceRoute(req, res, url, ctx, {
    spaceService, broadcastUiEvent,
  })) return;

  // /api/setup/apply — fans the user's confirmed SetupProposal out to
  // onboard_space. Triggered by the SetupProposalPanel's Apply button.
  if (await tryHandleSetupRoute(req, res, url, ctx, {
    spaceService, broadcastUiEvent,
  })) return;

  // /api/memories
  if (await tryHandleMemoryRoute(req, res, url, ctx, { memoryProvider, broadcastUiEvent })) return;

  // /api/auth/* — local glue (whoami / startSignIn / signOut). Real auth
  // (magic-link, OAuth) lives in the Cloudflare Worker.
  if (await tryHandleAuthRoute(req, res, url, ctx, { authService })) return;

  // /api/artifacts/:id/publish — publish + unpublish an artefact.
  if (await tryHandlePublishRoute(req, res, url, ctx, { publishService, broadcastUiEvent })) return;

  // /api/artifacts/:id/pin — pin / unpin an artefact (#387).
  if (await tryHandlePinRoute(req, res, url, ctx, { artifactService, broadcastUiEvent })) return;

  // /oauth/*, /.well-known/oauth-*, /mcp/*, /api/mcp/status
  // Pass the actually-bound `port`, not PREFERRED_PORT — findPort() may
  // have rolled forward (e.g. main repo's dev server already on 3333),
  // and the OAuth discovery + redirect URLs must advertise the real port.
  if (await tryHandleOAuthMcpRoute(req, res, url, ctx, {
    port,
    store, artifactService, iconGenerator, spaceService, memoryProvider,
    sessionStore, pendingReveals, broadcastUiEvent,
    userlandDir: USERLAND_DIR,
    getNativeSourcePath,
    publishService,
  })) return;

  // /api/import/* — paste-from-another-AI flow
  if (await tryHandleImportRoute(req, res, url, ctx, {
    store, spaceStore, spaceService, artifactService, memoryProvider,
    getNativeSourcePath, getOpenCodePort,
  })) return;

  // /api/resolve-path, /api/workspace, /api/vault/inventory,
  // /api/apps/:name/start|stop, /docs/:name, /artifacts/<rel>
  if (await tryHandleStaticRoute(req, res, url, ctx, {
    artifactService, spaceStore, db,
    layout: {
      oysterHome: OYSTER_HOME,
      spacesDir: SPACES_DIR,
      appsDir: APPS_DIR,
      dbDir: DB_DIR,
      configDir: CONFIG_DIR,
      backupsDir: BACKUPS_DIR,
    },
    startApp, stopApp, isPortOpen, waitForReady,
  })) return;

  // GET /api/ui/events — SSE stream for UI commands.
  // Local-origin only. The stream carries `mcp_client_connected` +
  // `mcp_tool_called` events (connected-agent telemetry), which a
  // cross-origin page in the same browser must not be able to observe
  // by opening an EventSource against a running local Oyster.
  if (url === "/api/ui/events") {
    if (rejectIfNonLocalOrigin()) return;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    uiClients.add(res);
    // SSE comment-line heartbeat every 25s. Browsers / proxies / dev
    // servers can silently close idle connections after ~30-60s of no
    // bytes; the heartbeat keeps the pipe warm so session_changed events
    // arrive promptly without the client having to refresh manually.
    const heartbeat = setInterval(() => {
      try { res.write(": heartbeat\n\n"); }
      catch { /* socket gone — close handler will clean up */ }
    }, 25_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      uiClients.delete(res);
    });
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

  // Chat SSE carries assistant output. Same origin gate as /api/ui/events:
  // a cross-origin page in the same browser must not be able to open an
  // EventSource against a running local Oyster and read the user's chat.
  if (url === "/api/chat/events" || url.startsWith("/api/chat/events?")) {
    if (rejectIfNonLocalOrigin()) return;
    attachChatEventClient(req, res);
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
      testServer.listen(port, "127.0.0.1", () => {
        testServer.close(() => resolve(port));
      });
    }
    tryPort(preferred);
  });
}

const port = await bootTimeAsync("findPort", () => findPort(PREFERRED_PORT));

// Write OpenCode config with the actual port so MCP URL is always correct.
// ?internal=1 lets the /mcp handler distinguish OpenCode's own traffic from
// external agents (Claude Code, Cursor, etc.) without relying on UA sniffing.
const INTERNAL_MCP_URL = `http://localhost:${port}/mcp/?internal=1`;
const opencodeConfig = readFileSync(join(PROJECT_ROOT, ".opencode", "config.toml"), "utf8")
  .replace(/# MCP config is written dynamically.*/, "")
  .trimEnd()
  + `\n\n[mcp.oyster]\ntype = "remote"\nurl = "${INTERNAL_MCP_URL}"\n`;
writeFileSync(join(USERLAND_DIR, ".opencode", "config.toml"), opencodeConfig);

// Also write opencode.json (OpenCode reads this from cwd)
const sourceOpencode = JSON.parse(readFileSync(join(PROJECT_ROOT, "opencode.json"), "utf8"));
sourceOpencode.mcp = { oyster: { type: "remote", url: INTERNAL_MCP_URL } };

// Inline the Oyster agent definition. We also copy the .md file into
// `.opencode/agents/` (bootstrapUserland), but opencode's filesystem-based
// agent discovery doesn't fire on Windows — the file is on disk but the
// agent never shows up in `tab` cycle, and our HTTP proxy's `agent: "oyster"`
// gets silently downgraded to the default build agent. Baking the agent
// into opencode.json side-steps discovery entirely and keeps Mac/Linux
// working too.
try {
  const agentSrc = readFileSync(join(PROJECT_ROOT, ".opencode", "agents", "oyster.md"), "utf8");
  const fm = agentSrc.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (fm) {
    const [, frontmatter, body] = fm;
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
    sourceOpencode.agent = {
      ...(sourceOpencode.agent || {}),
      oyster: {
        description: descMatch ? descMatch[1].trim() : "Oyster OS agent",
        prompt: body.trim(),
      },
    };
  }
} catch (err) {
  console.warn(`[bootstrap] could not inline oyster agent: ${err instanceof Error ? err.message : err}`);
}

writeFileSync(join(USERLAND_DIR, "opencode.json"), JSON.stringify(sourceOpencode, null, 2) + "\n");

bootMark("opencode config written, about to listen");

const httpServer = createServer(handleHttpRequest);
attachWebSocket(httpServer, { shell: SHELL, shellArgs: SHELL_ARGS, cwd: WORKSPACE, env: cleanEnv });

// Wipe any stale .dev-port from a prior crash before we listen, so wait-on
// can never succeed against a dead server's port. (See declaration above.)
clearDevPortFile();

httpServer.listen(port, "127.0.0.1", () => {
  bootMark(`httpServer listening on ${port}`);
  console.log(`Oyster server listening on http://127.0.0.1:${port}`);
  console.log(`  WebSocket: ws://127.0.0.1:${port}`);
  console.log(`  API:       http://127.0.0.1:${port}/api/artifacts`);
  try { writeFileSync(DEV_PORT_FILE, String(port)); } catch { /* best effort */ }

  // Spawn OpenCode AFTER server is listening so MCP connection succeeds
  spawnOpenCodeServe(OPENCODE_BIN, OPENCODE_PORT, USERLAND_DIR, cleanEnv);

  // Sessions arc — start the claude-code log watcher (#251). Failures
  // (missing ~/.claude/projects, permission denied) shouldn't block the
  // server; the watcher logs and stays dormant.
  const claudeCodeWatcher = new ClaudeCodeWatcher({
    sessionStore,
    spaceStore,
    artifactStore: store,
    emitSessionChanged: (id) =>
      broadcastUiEvent({ version: 1, command: "session_changed", payload: { id } }),
  });
  claudeCodeWatcher.start().catch((err) => {
    console.warn(`[claude-code-watcher] start failed: ${err instanceof Error ? err.message : err}`);
  });

  // Reap any orphaned opencode-ai processes from a prior Oyster run that
  // didn't shut down cleanly (SIGKILL, crash, laptop sleep). See #191.
  // Deferred to the next tick so a slow ps/PowerShell enumeration cannot
  // block the listen callback and delay the first request.
  setImmediate(() => {
    try {
      const sweep = sweepOrphanOpenCodeProcesses(OPENCODE_BIN);
      if (sweep.killed.length > 0) {
        console.log(`[opencode-sweep] reaped ${sweep.killed.length} orphan opencode-ai process(es): ${sweep.killed.join(", ")}`);
      }
      for (const msg of sweep.errors) console.warn(`[opencode-sweep] ${msg}`);
    } catch (err) {
      console.warn(`[opencode-sweep] failed: ${err instanceof Error ? err.message : err}`);
    }
  });
});
