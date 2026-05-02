import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, mkdirSync, statSync, copyFileSync, readdirSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown, renderMermaid } from "./renderers.js";
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
import { makeRouteCtx } from "./http-utils.js";
import { tryHandleSessionRoute } from "./routes/sessions.js";
import { tryHandleArtifactRoute } from "./routes/artifacts.js";
import { tryHandleSpaceRoute } from "./routes/spaces.js";
import { tryHandleMemoryRoute } from "./routes/memories.js";
import { tryHandleAuthRoute } from "./routes/auth.js";
import type { UiCommand } from "../../shared/types.js";
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
import { AuthService } from "./auth-service.js";
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

  // /api/memories
  if (await tryHandleMemoryRoute(req, res, url, ctx, { memoryProvider })) return;

  // /api/auth/* — local glue (whoami / startSignIn / signOut). Real auth
  // (magic-link, OAuth) lives in the Cloudflare Worker.
  if (await tryHandleAuthRoute(req, res, url, ctx, { authService })) return;

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

    // R6 (#310): map the calling MCP client to the session it's most likely
    // running inside, so memory writes/recalls get attributed. Internal
    // (?internal=1) is Oyster's own OpenCode subprocess → opencode session.
    // External claude-code / codex agents map to their respective sessions.
    // Codex attribution is best-effort today: there's no codex watcher yet
    // (#298 — that's the 0.9.0 multi-agent ingestion epic), so the lookup
    // will typically return no row and resolveActiveSessionId yields null.
    // The memory store falls back to NULL attribution gracefully. Other
    // UAs (Cursor, etc.) likewise fall through to null.
    const ua = externalUa ?? "";
    const attributableAgent: import("./session-store.js").SessionAgent | null =
      isInternal ? "opencode"
      : /claude/i.test(ua) ? "claude-code"
      : /codex/i.test(ua) ? "codex"
      : null;
    const resolveActiveSessionId = (): string | null => {
      if (!attributableAgent) return null;
      return sessionStore.getMostRecentActiveByAgent(attributableAgent)?.id ?? null;
    };

    const mcpServer = createMcpServer({
      store,
      service: artifactService,
      userlandDir: USERLAND_DIR,
      getNativeSourcePath,
      iconGenerator,
      spaceService,
      memoryProvider,
      sessionStore,
      pendingReveals,
      broadcastUiEvent,
      clientContext: isInternal ? { isInternal: true } : { isInternal: false, userAgent: externalUa ?? "unknown" },
      resolveActiveSessionId,
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
