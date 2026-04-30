import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, mkdirSync, statSync, copyFileSync, readdirSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, dirname, resolve, sep } from "node:path";
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
} from "./opencode-manager.js";
import { attachChatEventClient } from "./opencode-events.js";
import { sweepOrphanOpenCodeProcesses } from "./opencode-orphan-sweep.js";
import { spawnSession, attachWebSocket } from "./pty-manager.js";
import { createMcpServer } from "./mcp-server.js";
import {
  recordExternalRequest,
  listExternalClients,
  externalClientCount,
  lastConnectedAt,
} from "./mcp-client-tracker.js";
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

// Resolver for a space's native folder (where `create_artifact` writes).
// Every callsite that used to compute `join(USERLAND_DIR, space_id)` goes
// through this, so swapping to a first-class sources table later (#208) is
// a one-function change.
function getNativeSourcePath(spaceId: string): string {
  return join(SPACES_DIR, spaceId);
}

// Recursive size+count walker for /api/vault/inventory. Skips symlinks so
// we don't follow a circular link out of the userland tree, and ignores
// permission errors silently — a single unreadable file shouldn't fail
// the whole inventory.
function walkDirSize(dir: string): { count: number; size: number } {
  let count = 0;
  let size = 0;
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch { return { count, size }; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = walkDirSize(full);
      count += sub.count;
      size += sub.size;
    } else if (entry.isFile()) {
      try {
        const st = statSync(full);
        count += 1;
        size += st.size;
      } catch { /* unreadable, skip */ }
    }
  }
  return { count, size };
}

// Render the absolute OYSTER_HOME with the user's home dir collapsed to
// `~/` for display — keeps the Vault page header readable on shared
// screenshots without leaking the macOS username.
function humanizeHome(p: string): string {
  const h = homedir();
  return p.startsWith(h) ? "~" + p.slice(h.length) : p;
}

// Count immediate subdirectories. Used for Apps (one bundle = one
// directory) and Backups (one snapshot = one directory or file).
function countTopEntries(dir: string, opts: { dirsOnly?: boolean } = {}): number {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return opts.dirsOnly ? entries.filter((e) => e.isDirectory()).length : entries.length;
  } catch { return 0; }
}

interface VaultInventoryEntry {
  name: string;
  label: string;
  description: string;
  count: number;
  unit: string;
  size: number;
  exists: boolean;
  meta?: string;
}

// Cache for /api/vault/inventory. The walk visits every file under
// OYSTER_HOME plus the backups tree — easily seconds on a real install
// (large WAL, many spaces). Repeat hits within 30s reuse the last result
// so a user idly looking at the Pro page doesn't grind the disk on every
// re-render. SSE events that change the inventory (artefact CRUD, source
// attach/detach) bust the cache via `invalidateVaultInventoryCache()`.
let vaultInventoryCache: { result: VaultInventoryEntry[]; totalSize: number; root: string; expires: number } | null = null;
const VAULT_INVENTORY_TTL_MS = 30_000;

function invalidateVaultInventoryCache(): void { vaultInventoryCache = null; }

function buildVaultInventory(deps: { db: Database.Database; spaceStore: SqliteSpaceStore }): VaultInventoryEntry[] {
  const out: VaultInventoryEntry[] = [];

  // Spaces — DB rows are the source of truth (a space can have a repo_path
  // pointing outside SPACES_DIR). The on-disk SPACES_DIR is just where
  // native AI-generated artefacts land.
  const spaceCount = deps.spaceStore.getAll()
    .filter((s) => s.id !== "home" && s.id !== "__all__" && s.id !== "__archived__")
    .length;
  out.push({
    name: "spaces",
    label: "Spaces",
    description: "Your projects and workspaces",
    count: spaceCount,
    unit: "space",
    size: existsSync(SPACES_DIR) ? walkDirSize(SPACES_DIR).size : 0,
    exists: existsSync(SPACES_DIR),
  });

  // Apps — count bundles (top-level directories), not the recursive file
  // count. A bundle is the unit users actually think about.
  out.push({
    name: "apps",
    label: "Apps",
    description: "Installed plugin bundles",
    count: countTopEntries(APPS_DIR, { dirsOnly: true }),
    unit: "bundle",
    size: existsSync(APPS_DIR) ? walkDirSize(APPS_DIR).size : 0,
    exists: existsSync(APPS_DIR),
  });

  // Database — row count, not file count. Sums the user-facing tables
  // across both oyster.db and memory.db. SQL is wrapped in try/catch so
  // a missing table (e.g. on a fresh install) doesn't break the endpoint.
  let dbRows = 0;
  const tables = ["artifacts", "spaces", "sources", "sessions", "session_events", "session_artifacts"];
  for (const t of tables) {
    try {
      const row = deps.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number } | undefined;
      if (row) dbRows += row.n;
    } catch { /* table missing — skip */ }
  }
  // Memories live in a separate DB file; open read-only so a busy WAL
  // can't block us.
  try {
    const memDbPath = join(DB_DIR, "memory.db");
    if (existsSync(memDbPath)) {
      const memDb = new Database(memDbPath, { readonly: true, fileMustExist: true });
      try {
        const row = memDb.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number } | undefined;
        if (row) dbRows += row.n;
      } finally { memDb.close(); }
    }
  } catch { /* memory.db missing or unreadable — skip */ }
  out.push({
    name: "db",
    label: "Database",
    description: "Artefacts, sessions, memories",
    count: dbRows,
    unit: "row",
    size: existsSync(DB_DIR) ? walkDirSize(DB_DIR).size : 0,
    exists: existsSync(DB_DIR),
  });

  // Config — opencode-ai's config lives at OYSTER_HOME root (opencode.json
  // and the .opencode/ overrides), not under CONFIG_DIR. Count those files
  // directly so the row reflects what's actually configured.
  let configCount = 0;
  let configSize = 0;
  const opencodeJson = join(OYSTER_HOME, "opencode.json");
  if (existsSync(opencodeJson)) {
    try { configCount += 1; configSize += statSync(opencodeJson).size; } catch { /* skip */ }
  }
  const dotOpencode = join(OYSTER_HOME, ".opencode");
  if (existsSync(dotOpencode)) {
    const w = walkDirSize(dotOpencode);
    configCount += w.count; configSize += w.size;
  }
  if (existsSync(CONFIG_DIR)) {
    const w = walkDirSize(CONFIG_DIR);
    configCount += w.count; configSize += w.size;
  }
  out.push({
    name: "config",
    label: "Config",
    description: "Agent and workspace settings",
    count: configCount,
    unit: "file",
    size: configSize,
    exists: configCount > 0,
  });

  // Backups — `~/oyster-backups/`, NOT OYSTER_HOME/backups. The auto-backup
  // job (see backup.ts) writes to `auto/` (installed) or `dev/` (non-installed);
  // the `manual/` bucket is user-managed (snapshots they took themselves).
  // Walk all three buckets so the row reads accurate counts on either install
  // type, and so manual snapshots aren't ignored.
  const backupRoot = join(homedir(), "oyster-backups");
  let backupCount = 0;
  let backupSize = 0;
  let newestBackup: number | null = null;
  if (existsSync(backupRoot)) {
    let topEntries: Array<{ name: string; isDirectory(): boolean }> = [];
    try { topEntries = readdirSync(backupRoot, { withFileTypes: true }); } catch { /* skip */ }
    for (const entry of topEntries) {
      const full = join(backupRoot, entry.name);
      if (entry.isDirectory() && (entry.name === "auto" || entry.name === "dev" || entry.name === "manual")) {
        // Bucketed snapshots — each child of auto/dev/manual is one snapshot.
        let children: Array<{ name: string; isDirectory(): boolean }> = [];
        try { children = readdirSync(full, { withFileTypes: true }); } catch { continue; }
        for (const child of children) {
          if (!child.name.startsWith("backup-")) continue;
          backupCount += 1;
          const childPath = join(full, child.name);
          backupSize += walkDirSize(childPath).size;
          try {
            const t = statSync(childPath).mtimeMs;
            if (newestBackup === null || t > newestBackup) newestBackup = t;
          } catch { /* skip */ }
        }
      } else if (entry.isDirectory() && entry.name.startsWith("backup-")) {
        // Legacy flat snapshots directly under ~/oyster-backups/.
        backupCount += 1;
        backupSize += walkDirSize(full).size;
        try {
          const t = statSync(full).mtimeMs;
          if (newestBackup === null || t > newestBackup) newestBackup = t;
        } catch { /* skip */ }
      }
    }
  }
  let backupMeta: string | undefined;
  if (newestBackup !== null) {
    const days = Math.floor((Date.now() - newestBackup) / 86_400_000);
    backupMeta = days <= 0 ? "newest today" : `newest ${days}d ago`;
  }
  out.push({
    name: "backups",
    label: "Backups",
    description: "Local snapshots of the database",
    count: backupCount,
    unit: "snapshot",
    size: backupSize,
    exists: backupCount > 0,
    meta: backupMeta,
  });

  return out;
}

// For the watcher and scanExistingArtifacts, which walk a single directory
// looking for app-bundle folders. In the new layout, bundles live under
// APPS_DIR (installed) or SPACES_DIR/<space>/ (AI-generated). Both need to
// be scanned; see the callsites below.
const ARTIFACTS_DIR = join(OYSTER_HOME, "")  + sep;

// Resolve a /artifacts/<relativePath> URL to a file on disk. The icon
// resolver in artifact-service emits URLs like /artifacts/<folder>/icon.png
// using just the folder name (the artifact's bundle dir), so this handler
// has to try every place that folder could live after #207:
//
//   OYSTER_HOME/<rel>          — dedicated icons/<id>/ + legacy flat
//   APPS_DIR/<rel>             — installed bundles (builtins + community)
//   SPACES_DIR/<rel>           — <rel> starts with a space name (e.g. blunderfixer/icon.png)
//   SPACES_DIR/<space>/<rel>   — <rel> is a bundle folder inside a space (e.g. car-racer/icon.png
//                                 which lives at spaces/home/car-racer/)
//
// Returns the first existing candidate under OYSTER_HOME (path-traversal guard),
// or null. Used by both /api/resolve-artifact-path and the static /artifacts/
// server so they stay in sync.
function resolveArtifactsUrl(relativePath: string): string | null {
  // Fast path: check the three fixed candidates first. This covers the vast
  // majority of requests (icons/, APPS_DIR builtins, space-name-as-first-seg)
  // without touching the filesystem beyond `existsSync`. Only fall back to
  // walking every space directory when those miss — that's a real-but-rare
  // case (AI-generated app inside a user space whose icon URL is just
  // /artifacts/<app>/icon.png with no space hint).
  // Containment helper — a raw string startsWith(OYSTER_HOME) would let
  // "/Users/me/OysterX/..." pass when OYSTER_HOME is "/Users/me/Oyster".
  // Resolve both and require an exact match or a path-sep-terminated prefix.
  const root = resolve(OYSTER_HOME);
  const isInsideRoot = (candidate: string): boolean => {
    const r = resolve(candidate);
    return r === root || r.startsWith(root + sep);
  };
  const fixedCandidates = [
    join(OYSTER_HOME, relativePath),
    join(APPS_DIR, relativePath),
    join(SPACES_DIR, relativePath),
  ];
  for (const candidate of fixedCandidates) {
    if (!isInsideRoot(candidate)) continue;
    if (existsSync(candidate)) return candidate;
  }
  const firstSegment = relativePath.split("/")[0];
  if (!firstSegment || firstSegment === "icons") return null;
  try {
    for (const spaceName of readdirSync(SPACES_DIR)) {
      const candidate = join(SPACES_DIR, spaceName, relativePath);
      if (isInsideRoot(candidate) && existsSync(candidate)) return candidate;
    }
  } catch { /* SPACES_DIR might not exist on a fresh install */ }
  return null;
}

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
runStartupBackup(OYSTER_HOME);
setImportStatePath(OYSTER_HOME);

bootstrapUserland();

// ── Clean environment (no OpenAI key leak to subprocesses) ──

const cleanEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) cleanEnv[k] = v;
}
delete cleanEnv["OPENAI_API_KEY"];

// ── Artifact store ──

const db = initDb(DB_DIR);
const store = new SqliteArtifactStore(db);
const spaceStore = new SqliteSpaceStore(db);
const sessionStore = new SqliteSessionStore(db);
// artifactService reads the dedicated icons dir at `<root>/icons/<id>/icon.png`
// — that lives at OYSTER_HOME root (URL-addressable via /artifacts/icons/...),
// not inside DB_DIR. spaceStore is passed in so rowToArtifact can resolve the
// linked-source path for tiles whose `source_id` is non-null.
const artifactService = new ArtifactService(store, OYSTER_HOME, spaceStore);

// Shared resolver: try raw id, then slugified id, then case-insensitive display_name.
// Used by import preview + execute so an agent-emitted space name (possibly
// whitespace-padded or referring to a renamed space) resolves consistently.
function resolveSpaceRow(name: string) {
  const trimmed = name.trim();
  return (
    spaceStore.getById(trimmed) ??
    spaceStore.getById(slugify(trimmed)) ??
    spaceStore.getByDisplayName(trimmed)
  );
}
const spaceService = new SpaceService(spaceStore, store, artifactService, sessionStore);
const memoryProvider = new SqliteFtsMemoryProvider(DB_DIR);
await memoryProvider.init();

// ── Initialize subsystems ──

const iconGenerator = new IconGenerator(updateGeneratedArtifact);
const pendingReveals = new Set<string>();

spawnSession(SHELL, SHELL_ARGS, WORKSPACE, cleanEnv);

// OpenCode spawn is deferred until after port resolution (see below)
// Scan every location where app bundles can live after #207:
//   APPS_DIR               — installed builtins + community apps
//   SPACES_DIR/<space>/    — AI-generated apps owned by a space
//   OYSTER_HOME            — anything still at the root (legacy / newly-generated
//                            before the agent's CWD gets re-pointed in a follow-up)
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

  // ── Shared helpers ──
  // Defined near the top so early routes (e.g. GET /api/artifacts) can use
  // them too, not just the later mutation routes.

  const sendJson = (data: unknown, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  // Throwable that carries an HTTP status — lets readJsonBody and others
  // surface a specific status (e.g. 413) without writing the response
  // themselves, which would race the caller's own catch-block response.
  class HttpError extends Error {
    constructor(message: string, public status: number) { super(message); this.name = "HttpError"; }
  }
  const sendError = (err: unknown, fallback = 400) => {
    if (err instanceof HttpError) sendJson({ error: err.message }, err.status);
    else sendJson({ error: err instanceof Error ? err.message : String(err) }, fallback);
  };

  // Mutation endpoints only accept tiny config bodies ({label, group_name}
  // etc). Cap at 64 KB to prevent memory/CPU abuse from an oversized payload.
  const MAX_MUTATION_BODY = 64_000;
  async function readJsonBody(): Promise<Record<string, unknown>> {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_MUTATION_BODY) {
        // Destroy the socket so we stop reading further bytes from an
        // oversized payload — unlike a plain throw, which lets the rest
        // of the stream keep draining. Matches the /api/import/* pattern.
        req.destroy();
        throw new HttpError("Payload too large", 413);
      }
    }
    if (!body) return {};
    try { return JSON.parse(body) as Record<string, unknown>; }
    catch { throw new HttpError("Invalid JSON body", 400); }
  }

  // Artifact endpoints (both reads and mutations) are localhost-only. A
  // browser tab on some other site could otherwise fetch user data or
  // trigger destructive actions via http://localhost:<port>/api/…. Mirrors
  // the /mcp handler pattern: reject non-local origins outright; echo the
  // origin back for local ones to override the wildcard CORS header set
  // above.
  const rejectIfNonLocalOrigin = (): boolean => {
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      sendJson({ error: "Forbidden origin" }, 403);
      return true;
    }
    if (!origin) {
      const remote = req.socket.remoteAddress || "";
      const isLoopback =
        remote === "127.0.0.1" ||
        remote === "::1" ||
        remote === "::ffff:127.0.0.1";
      if (!isLoopback) {
        sendJson({ error: "Forbidden — non-local origin" }, 403);
        return true;
      }
    }
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    return false;
  };

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

    // /artifacts/... → resolveArtifactsUrl walks the split layout.
    if (!filePath && targetUrl.startsWith("/artifacts/")) {
      const relativePath = targetUrl.slice("/artifacts/".length).split("?")[0];
      const resolved = resolveArtifactsUrl(relativePath);
      if (resolved) filePath = resolved;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ filePath: filePath || null }));
    return;
  }

  // GET /api/artifacts — the full live artifact list. Local-origin-only for
  // the same reason /api/artifacts/archived is: it contains user-private
  // artifact metadata that a malicious cross-origin site could otherwise
  // enumerate against a running local Oyster.
  // /api/workspace → the resolved Oyster workspace layout, used by the
  // "Where do my files live?" builtin so it shows this user's actual paths
  // (respects OYSTER_USERLAND + dev vs installed). Local-origin gated for
  // the same reason as /api/artifacts — paths are user-private.
  if (url === "/api/workspace") {
    if (rejectIfNonLocalOrigin()) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      oysterHome: OYSTER_HOME,
      paths: {
        db: DB_DIR,
        apps: APPS_DIR,
        spaces: SPACES_DIR,
        backups: BACKUPS_DIR,
      },
      platform: process.platform,
      spaces: (() => {
        try { return readdirSync(SPACES_DIR).filter((e) => {
          try { return statSync(join(SPACES_DIR, e)).isDirectory(); } catch { return false; }
        }); } catch { return []; }
      })(),
    }));
    return;
  }

  // /api/spaces/:id/sources — active sources (linked folders) for a
  // space. Local-origin only: paths leak the user's home directory.
  // Surfaces #266 plus attach/detach from the Folders section.
  {
    const sourcesPath = url.split("?")[0];
    const m = sourcesPath.match(/^\/api\/spaces\/([^/]+)\/sources$/);
    if (m && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return;
      try {
        sendJson(spaceService.getSources(m[1]));
      } catch (err) {
        sendError(err, 500);
      }
      return;
    }
    // POST /api/spaces/:id/sources — { path } attaches a folder. Mirrors
    // the chat-bar `onboard_space` flow: addSource then scan so artefacts
    // surface in the same round-trip.
    if (m && req.method === "POST") {
      if (rejectIfNonLocalOrigin()) return;
      try {
        const body = await readJsonBody();
        const path = typeof body.path === "string" ? body.path.trim() : "";
        if (!path) {
          sendJson({ error: "path is required" }, 400);
          return;
        }
        const source = spaceService.addSource(m[1], path);
        // Fire scan but don't block the response — tiles surface via SSE
        // as the watcher / scanner picks them up. A long scan would
        // otherwise hang the Folders UI for many seconds on a big repo.
        spaceService.scanSpace(m[1]).catch((err) => {
          console.warn("[attach-source] scan failed:", err instanceof Error ? err.message : err);
        });
        sendJson(source, 201);
      } catch (err) {
        sendError(err);
      }
      return;
    }
    // DELETE /api/spaces/:id/sources/:source_id — detach a folder.
    // Soft-deletes the source row AND every artifact that came from it.
    const dm = sourcesPath.match(/^\/api\/spaces\/([^/]+)\/sources\/([^/]+)$/);
    if (dm && req.method === "DELETE") {
      if (rejectIfNonLocalOrigin()) return;
      try {
        const [, spaceId, sourceId] = dm;
        const source = spaceService.getSourceById(sourceId);
        if (!source || source.space_id !== spaceId) {
          sendJson({ error: "source not found in this space" }, 404);
          return;
        }
        spaceService.removeSource(sourceId);
        res.writeHead(204);
        res.end();
      } catch (err) {
        sendError(err);
      }
      return;
    }
  }

  // POST /api/spaces/from-path — one-shot "promote folder to space": create
  // a new space named after the folder, attach the path as its sole source,
  // and re-attribute orphan sessions whose cwd matches. Local-origin gated +
  // size-capped — it accepts a filesystem path so it inherits the same
  // hardening as /api/spaces/:id/sources POST.
  if (url === "/api/spaces/from-path" && req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return;
    try {
      const body = await readJsonBody();
      const path = typeof body.path === "string" ? body.path.trim() : "";
      const name = typeof body.name === "string" ? body.name.trim() : undefined;
      if (!path) {
        sendJson({ error: "path is required" }, 400);
        return;
      }
      const { space } = spaceService.createSpaceFromPath({ path, name });
      // Tell connected clients to refetch sessions — the backfill just
      // moved orphan rows from `(NULL, NULL)` to `(space, source)` and the
      // hook only otherwise refreshes when the watcher fires.
      broadcastUiEvent({ version: 1, command: "session_changed", payload: { id: "" } });
      // Trigger an initial scan in the background so artefacts surface via
      // SSE — same UX as /api/spaces/:id/sources POST.
      spaceService.scanSpace(space.id).catch((err) => {
        console.warn("[from-path] scan failed:", err instanceof Error ? err.message : err);
      });
      sendJson(space, 201);
    } catch (err) {
      sendError(err);
    }
    return;
  }

  // GET /api/vault/inventory — what's currently in the user's ~/Oyster
  // root: file count + on-disk size for each top-level subdir. Powers the
  // Vault info page so users can see what cloud sync (when it ships) will
  // be backing up. Local-origin only — surfaces filesystem layout.
  if (url === "/api/vault/inventory" && req.method === "GET") {
    if (rejectIfNonLocalOrigin()) return;
    try {
      const now = Date.now();
      if (!vaultInventoryCache || vaultInventoryCache.expires <= now) {
        const result = buildVaultInventory({ db, spaceStore });
        const totalSize = result.reduce((acc, r) => acc + r.size, 0);
        vaultInventoryCache = {
          result,
          totalSize,
          root: humanizeHome(OYSTER_HOME),
          expires: now + VAULT_INVENTORY_TTL_MS,
        };
      }
      sendJson({
        root: vaultInventoryCache.root,
        totalSize: vaultInventoryCache.totalSize,
        entries: vaultInventoryCache.result,
      });
    } catch (err) {
      sendError(err, 500);
    }
    return;
  }

  // GET /api/memories — list memories, optionally scoped to a space.
  // Local-origin only: memory contents are private user notes. Strip the
  // query string before path-matching (same trap the events route had —
  // `$`-anchored regex would silently reject `?space_id=…`).
  {
    const memoriesPath = url.split("?")[0];
    if (memoriesPath === "/api/memories" && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return;
      const parsed = new URL(req.url ?? "/", "http://localhost");
      const spaceId = parsed.searchParams.get("space_id");
      try {
        const memories = await memoryProvider.list(spaceId ?? undefined);
        sendJson(memories);
      } catch (err) {
        sendError(err, 500);
      }
      return;
    }
    // POST /api/memories — user-authored memory. Mirrors the MCP `remember`
    // tool: empty content rejected, exact-content dedupe, space optional.
    if (memoriesPath === "/api/memories" && req.method === "POST") {
      if (rejectIfNonLocalOrigin()) return;
      try {
        const body = await readJsonBody();
        const content = typeof body.content === "string" ? body.content.trim() : "";
        if (!content) {
          sendJson({ error: "content is required" }, 400);
          return;
        }
        const space_id = typeof body.space_id === "string" && body.space_id ? body.space_id : undefined;
        const tags = Array.isArray(body.tags)
          ? body.tags.filter((t): t is string => typeof t === "string" && t.length > 0)
          : undefined;
        const memory = await memoryProvider.remember({ content, space_id, tags });
        sendJson(memory, 201);
      } catch (err) {
        sendError(err);
      }
      return;
    }
  }

  // GET /api/sessions — agent sessions captured by the watchers (#251).
  // Read-only for 0.5.0; the home feed renders these. Local-origin only —
  // session titles are derived from user prompts, which are private.
  if (url === "/api/sessions" && req.method === "GET") {
    if (rejectIfNonLocalOrigin()) return;
    const rows = sessionStore.getAll();
    // Join sources for sourceLabel — batched IN-list queries so the
    // home feed can show "active project" tiles without a per-tile
    // round trip. Sources are dedup'd because most sessions cluster
    // around a small number of registered folders. Chunked at 500
    // ids per batch to stay well below SQLite's 999-bound-variable
    // ceiling on installs that haven't been recompiled with the
    // higher 32_766 limit.
    const sourceIds = [...new Set(rows.map((r) => r.source_id).filter((id): id is string => !!id))];
    const SOURCE_BATCH = 500;
    const sourceList = [];
    for (let i = 0; i < sourceIds.length; i += SOURCE_BATCH) {
      sourceList.push(...spaceStore.getSourcesByIds(sourceIds.slice(i, i + SOURCE_BATCH)));
    }
    const sourcesById = new Map(sourceList.map((s) => [s.id, s]));
    sendJson(rows.map((row) => {
      const src = row.source_id ? sourcesById.get(row.source_id) : null;
      const label = src ? (src.label ?? (basename(src.path) || null)) : null;
      return {
        id: row.id,
        spaceId: row.space_id,
        sourceId: row.source_id ?? null,
        sourceLabel: label,
        cwd: row.cwd,
        agent: row.agent,
        title: row.title,
        state: row.state,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        model: row.model,
        lastEventAt: row.last_event_at,
      };
    }));
    return;
  }

  // GET /api/sessions/:id — single session row (or 404)
  {
    const m = url.match(/^\/api\/sessions\/([^/]+)$/);
    if (m && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return;
      const row = sessionStore.getById(m[1]);
      if (!row) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "session not found" }));
        return;
      }
      const src = row.source_id ? spaceStore.getSourceById(row.source_id) : undefined;
      const sourceLabel = src ? (src.label ?? (basename(src.path) || null)) : null;
      sendJson({
        id: row.id,
        spaceId: row.space_id,
        sourceId: row.source_id ?? null,
        sourceLabel,
        cwd: row.cwd,
        agent: row.agent,
        title: row.title,
        state: row.state,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        model: row.model,
        lastEventAt: row.last_event_at,
      });
      return;
    }
  }

  // GET /api/sessions/:id/events — transcript events (oldest first within
  // the returned slice). The `raw` JSONL line is dropped because long
  // sessions can ship 50+MB of raw blobs; clients lazy-fetch raw via
  // /events/:eventId when they expand a tool turn.
  //
  // Cursors:
  //   ?before=<id> — events with id < before, latest N (load older on scroll up)
  //   ?after=<id>  — events with id > after, oldest N (live append)
  //   neither     — latest N (bootstrap)
  // ?limit=N defaults to 1000.
  {
    // Strip the query string before path matching — the `$` anchor in the
    // regex would otherwise reject any URL with `?...`. Pre-existing bug:
    // `?limit=N` was always silently ignored before this fix.
    const eventsPath = url.split("?")[0];
    const m = eventsPath.match(/^\/api\/sessions\/([^/]+)\/events$/);
    if (m && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return;
      const parsed = new URL(req.url ?? "/", "http://localhost");
      const limitParam = parsed.searchParams.get("limit");
      const limit = limitParam && Number.isFinite(Number(limitParam))
        ? Math.max(1, Math.min(10_000, Number(limitParam)))
        : 1000;
      const beforeParam = parsed.searchParams.get("before");
      const afterParam = parsed.searchParams.get("after");
      const before = beforeParam && Number.isFinite(Number(beforeParam))
        ? Number(beforeParam) : null;
      const after = afterParam && Number.isFinite(Number(afterParam))
        ? Number(afterParam) : null;
      let events;
      if (before !== null) {
        events = sessionStore.getEventsBeforeBySession(m[1], before, limit);
      } else if (after !== null) {
        events = sessionStore.getEventsAfterBySession(m[1], after, limit);
      } else {
        events = sessionStore.getEventsBySession(m[1], { limit });
      }
      sendJson(events.map((e) => ({
        id: e.id,
        sessionId: e.session_id,
        role: e.role,
        text: e.text,
        ts: e.ts,
        raw: null as string | null,
      })));
      return;
    }
  }

  // GET /api/sessions/:id/events/:eventId — single event WITH raw JSONL.
  // Exists so the inspector can lazily load the raw blob for tool-call
  // expand without paying for it on every transcript fetch.
  {
    const m = url.match(/^\/api\/sessions\/([^/]+)\/events\/(\d+)$/);
    if (m && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return;
      const eventId = Number(m[2]);
      const ev = sessionStore.getEventById(m[1], eventId);
      if (!ev) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "event not found" }));
        return;
      }
      sendJson({
        id: ev.id,
        sessionId: ev.session_id,
        role: ev.role,
        text: ev.text,
        ts: ev.ts,
        raw: ev.raw,
      });
      return;
    }
  }

  // GET /api/sessions/:id/artifacts — touched artefacts joined with artifact metadata
  {
    const m = url.match(/^\/api\/sessions\/([^/]+)\/artifacts$/);
    if (m && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return;
      const touches = sessionStore.getArtifactsBySession(m[1]);
      const uniqueIds = Array.from(new Set(touches.map((t) => t.artifact_id)));
      const artifacts = await artifactService.getArtifactsByIds(uniqueIds);
      const byId = new Map(artifacts.map((a) => [a.id, a]));
      sendJson(touches.flatMap((t) => {
        const a = byId.get(t.artifact_id);
        if (!a) return [];
        return [{
          id: t.id,
          sessionId: t.session_id,
          artifactId: t.artifact_id,
          role: t.role,
          whenAt: t.when_at,
          artifact: a,
        }];
      }));
      return;
    }
  }

  // GET /api/artifacts/:id/sessions — sessions that touched this artefact (M:N reverse).
  // Must come BEFORE the generic /api/artifacts/:id PATCH handler so "/sessions"
  // suffix is never interpreted as an artifact id.
  {
    const m = url.match(/^\/api\/artifacts\/([^/]+)\/sessions$/);
    if (m && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return;
      const touches = sessionStore.getSessionsByArtifact(m[1]);
      const allSessions = sessionStore.getAll();
      const byId = new Map(allSessions.map((s) => [s.id, s]));
      sendJson(touches.flatMap((t) => {
        const s = byId.get(t.session_id);
        if (!s) return [];
        return [{
          id: t.id,
          sessionId: t.session_id,
          artifactId: t.artifact_id,
          role: t.role,
          whenAt: t.when_at,
          session: {
            id: s.id,
            spaceId: s.space_id,
            sourceId: s.source_id ?? null,
            sourceLabel: null,
            cwd: s.cwd,
            agent: s.agent,
            title: s.title,
            state: s.state,
            startedAt: s.started_at,
            endedAt: s.ended_at,
            model: s.model,
            lastEventAt: s.last_event_at,
          },
        }];
      }));
      return;
    }
  }

  if (url === "/api/artifacts") {
    if (rejectIfNonLocalOrigin()) return;
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
      sendError(err, 500);
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
      sendError(err);
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
      sendError(err);
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
      sendError(err);
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
      sendError(err);
    }
    return;
  }

  // POST /api/artifacts/:id/icon/regenerate — trigger a fresh AI icon for
  // an artifact. Mirrors the MCP `regenerate_icon` tool so the UI can offer
  // a right-click "Regenerate icon" action without going through chat.
  //
  // Builtins: their id is `gen:<folder>` and they have no DB row. The
  // service-layer lookup would miss them; handle directly from APPS_DIR.
  // Overwriting the icon.png there persists across restarts (bootstrap is
  // add-only) — next `npm install -g oyster-os` upgrade would reset it,
  // which is acceptable.
  const iconRegenMatch = url.match(/^\/api\/artifacts\/([^/]+)\/icon\/regenerate$/);
  if (iconRegenMatch && req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return;
    const id = decodeURIComponent(iconRegenMatch[1]);

    let label: string | undefined;
    let artifactKind: string | undefined;
    let artifactDir: string | undefined;

    if (id.startsWith("gen:")) {
      // Builtin or unreconciled generated artifact — look up by walking the
      // same candidate roots the scanner walks: APPS_DIR for installed /
      // builtin bundles, plus each SPACES_DIR/<space>/ for space-scoped
      // generated ones (matches scanExistingArtifacts' coverage).
      const folderId = id.slice("gen:".length);
      // Strict whitelist — stops traversal via URL-encoded "../", backslashes,
      // etc. before it hits the filesystem. Mirrors the validation on
      // /api/plugins/:id/uninstall; keep the two in sync.
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(folderId)) {
        sendJson({ error: `Invalid artifact id '${id}'` }, 400); return;
      }
      const candidateDirs: string[] = [join(APPS_DIR, folderId)];
      try {
        for (const spaceName of readdirSync(SPACES_DIR)) {
          const spaceDir = join(SPACES_DIR, spaceName);
          try {
            if (!statSync(spaceDir).isDirectory()) continue;
          } catch { continue; }
          candidateDirs.push(join(spaceDir, folderId));
        }
      } catch { /* SPACES_DIR missing on a fresh install */ }

      // Defence in depth: even with the whitelist above, verify every
      // candidate is actually inside OYSTER_HOME via resolve()+sep before
      // reading it. Normalises path segments (handles any accidental `..`
      // that slipped past the allowlist, double slashes, etc.) — does NOT
      // follow symlinks; realpathSync would be needed for that, and is
      // filed as future hardening since the allowlist already bars the
      // usual traversal vectors.
      const rootPath = resolve(OYSTER_HOME);
      const resolvedDir = candidateDirs.find((d) => {
        const r = resolve(d);
        if (r !== rootPath && !r.startsWith(rootPath + sep)) return false;
        return existsSync(join(d, "manifest.json"));
      });
      if (!resolvedDir) {
        sendJson({ error: `Artifact "${id}" not found` }, 404); return;
      }
      try {
        const manifest = JSON.parse(readFileSync(join(resolvedDir, "manifest.json"), "utf8"));
        label = manifest.name;
        artifactKind = manifest.type;
        artifactDir = resolvedDir;
      } catch (err) {
        sendJson({ error: `Failed to read manifest for "${id}": ${(err as Error).message}` }, 500); return;
      }
    } else {
      const artifact = await artifactService.getArtifactById(id);
      if (!artifact) { sendJson({ error: `Artifact "${id}" not found` }, 404); return; }
      const sourcePath = artifactService.getDocFile(id);
      if (!sourcePath) { sendJson({ error: "Icon regeneration is only supported for static file artifacts" }, 400); return; }
      // Only write the icon into a bundle root when the source is laid out
      // as a manifest-based bundle (source file lives under a `src/` dir).
      // For single-file artifacts (a loose .md / .html) the "natural dir" is
      // the containing folder — which might hold many artifacts — so the
      // regenerated icon would overwrite a shared icon.png. Route those to
      // the per-artifact dedicated dir at OYSTER_HOME/icons/<id>/ instead;
      // ArtifactService.resolveIcon checks that path first.
      //
      // Containment must use resolve() + sep-terminated prefix — a raw
      // startsWith(OYSTER_HOME) would match "/.../OysterX/..." too.
      const srcIdx = sourcePath.lastIndexOf(`${sep}src${sep}`);
      const bundleRoot = srcIdx !== -1 ? resolve(sourcePath.slice(0, srcIdx)) : null;
      const rootPath = resolve(OYSTER_HOME);
      const isManifestBundle = bundleRoot !== null
        && (bundleRoot === rootPath || bundleRoot.startsWith(rootPath + sep));
      artifactDir = isManifestBundle ? sourcePath.slice(0, srcIdx) : join(OYSTER_HOME, "icons", id);
      label = artifact.label;
      artifactKind = artifact.artifactKind;
    }

    mkdirSync(artifactDir!, { recursive: true });
    const queued = iconGenerator.forceEnqueue(id, label!, artifactKind! as ArtifactKind, artifactDir!);
    if (!queued) {
      sendJson({ error: "Icon generation is disabled on this install (FAL_KEY not configured)" }, 503);
      return;
    }
    sendJson({ status: "queued", id, label });
    return;
  }

  // POST /api/plugins/:id/uninstall — remove an app bundle from disk.
  // Post-#207 the bundle could live at APPS_DIR/<id>/ (installed) or
  // SPACES_DIR/<space>/<id>/ (AI-generated under a space). Search both,
  // plus legacy OYSTER_HOME/<id>/ for any un-migrated install.
  // The artifact detector + getAllArtifacts self-heal DB entries.
  const pluginUninstallMatch = url.match(/^\/api\/plugins\/([^/]+)\/uninstall$/);
  if (pluginUninstallMatch && req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return;
    const id = decodeURIComponent(pluginUninstallMatch[1]);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      sendJson({ error: `Invalid plugin id '${id}'` }, 400);
      return;
    }
    const candidates: string[] = [
      join(APPS_DIR, id),
      join(OYSTER_HOME, id),
    ];
    try {
      for (const spaceName of readdirSync(SPACES_DIR)) {
        candidates.push(join(SPACES_DIR, spaceName, id));
      }
    } catch { /* no SPACES_DIR yet on fresh install */ }

    // resolve()+sep-terminated-prefix check — the raw startsWith would let
    // an `OysterX` sibling match `Oyster`. Same hardening pattern used in
    // resolveArtifactsUrl and the icon-regen endpoint.
    const rootPath = resolve(OYSTER_HOME);
    const dir = candidates.find((c) => {
      const r = resolve(c);
      if (r !== rootPath && !r.startsWith(rootPath + sep)) return false;
      return existsSync(c);
    });
    if (!dir) {
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
      sendJson({ id, uninstalled: true, path: dir });
    } catch (err) {
      sendError(err, 500);
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
      sendError(err);
    }
    return;
  }

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

  // ── Static file serving for /artifacts/ ──
  // Uses the shared resolveArtifactsUrl walker so this stays in sync with the
  // /api/resolve-artifact-path helper above. The walker enforces the
  // path-traversal guard (must stay under OYSTER_HOME).
  if (url.startsWith("/artifacts/")) {
    const urlPath = url.split("?")[0];
    const relativePath = urlPath.slice("/artifacts/".length);
    const filePath = resolveArtifactsUrl(relativePath);

    if (!filePath) {
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

  if (await handleSpacesRequest(url, req, res, spaceService, () => {
    broadcastUiEvent({ version: 1, command: "session_changed", payload: { id: "" } });
  })) return;

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
          resolveSpaceByName: (name) => {
            const row = resolveSpaceRow(name);
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
          createArtifact: (params) => artifactService.createArtifact(params, getNativeSourcePath(params.space_id)),
          remember: (input) => memoryProvider.remember(input),
          findMemory: (content, spaceId) => memoryProvider.findExact(content, spaceId ?? undefined),
          resolveSpaceByName: (name) => {
            const row = resolveSpaceRow(name);
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
  if (url === "/mcp" || url.startsWith("/mcp/") || url.startsWith("/mcp?")) {
    // Localhost-only: reject non-local origins and don't emit wildcard CORS
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    // Override the wildcard CORS header set at the top of handleHttpRequest
    res.setHeader("Access-Control-Allow-Origin", origin || `http://localhost:${PREFERRED_PORT}`);

    // `?internal=1` = Oyster's own embedded OpenCode subprocess; anything
    // else is an external agent (Claude Code / Cursor / etc.). The query
    // param is set at config-write time when we compose OpenCode's mcp URL.
    // Parse properly — substring matching would false-positive on
    // `?notinternal=1` or other values containing the literal.
    const isInternal = new URL(url, "http://localhost").searchParams.get("internal") === "1";
    let externalUa: string | null = null;

    if (!isInternal) {
      const { userAgent, isNew } = recordExternalRequest(req.headers["user-agent"]);
      externalUa = userAgent;
      if (isNew) {
        // Broadcast a bare "a new client connected" signal — enough for
        // the dock to flip step 1, with no UA leaked on the SSE stream
        // even if the origin gate is somehow bypassed. Exact UA is still
        // available via /api/mcp/status (local-origin only).
        broadcastUiEvent({
          version: 1,
          command: "mcp_client_connected",
          payload: { at: new Date().toISOString() },
        });
      }
    }

    const mcpServer = createMcpServer({
      store,
      service: artifactService,
      userlandDir: USERLAND_DIR,
      getNativeSourcePath,
      iconGenerator,
      spaceService,
      memoryProvider,
      pendingReveals,
      broadcastUiEvent,
      clientContext: isInternal ? { isInternal: true } : { isInternal: false, userAgent: externalUa ?? "unknown" },
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); mcpServer.close(); });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  // ── MCP status (onboarding fallback) ──
  // Local-origin only — the response discloses which MCP clients are
  // connected (user-agent strings + timestamps), which a cross-origin
  // site running in the same browser shouldn't be able to enumerate.
  if (url === "/api/mcp/status" && req.method === "GET") {
    if (rejectIfNonLocalOrigin()) return;
    json(res, {
      connected_clients: externalClientCount(),
      last_client_connected_at: lastConnectedAt(),
      clients: listExternalClients(),
    });
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

const port = await findPort(PREFERRED_PORT);

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

const httpServer = createServer(handleHttpRequest);
attachWebSocket(httpServer);

httpServer.listen(port, "127.0.0.1", () => {
  console.log(`Oyster server listening on http://127.0.0.1:${port}`);
  console.log(`  WebSocket: ws://127.0.0.1:${port}`);
  console.log(`  API:       http://127.0.0.1:${port}/api/artifacts`);

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
