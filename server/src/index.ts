import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, mkdirSync, statSync, copyFileSync, readdirSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { randomUUID } from "node:crypto";
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
import { acquireLock, AlreadyRunningError, releaseLock, setLockPort } from "./single-instance-lock.js";
import { lookupProject } from "./lookup-project.js";
import { initDb } from "./db.js";
import { SqliteArtifactStore } from "./artifact-store.js";
import { SqliteSessionStore } from "./session-store.js";
import { ClaudeCodeWatcher } from "./watchers/claude-code.js";
import { ArtifactService } from "./artifact-service.js";
import { SqliteSpaceStore } from "./space-store.js";
import { SpaceService } from "./space-service.js";
import { SessionService } from "./session-service.js";
import { slugify } from "./utils.js";
import { makeRouteCtx } from "./http-utils.js";
import { tryHandleSessionRoute } from "./routes/sessions.js";
import { tryHandleArtifactRoute } from "./routes/artifacts.js";
import { tryHandleSpaceRoute } from "./routes/spaces.js";
import { tryHandleProjectsRoute } from "./routes/projects.js";
import { ProjectService } from "./project-service.js";
import { tryHandleSetupRoute } from "./routes/setup.js";
import { tryHandleMemoryRoute } from "./routes/memories.js";
import { tryHandleAuthRoute } from "./routes/auth.js";
import { tryHandlePublishRoute } from "./routes/publish.js";
import { tryHandlePinRoute } from "./routes/pin.js";
import { tryHandleDeviceRoute } from "./routes/device.js";
import { createPublishService, PublishError } from "./publish-service.js";
import { createSpaceSyncService } from "./space-sync-service.js";
import { createMemorySyncService, type MemorySyncService } from "./memory-sync-service.js";
import { createSessionSyncService, encodeCwd, projectsRoot, type SessionSyncService } from "./session-sync-service.js";
import { createProfileBindingService } from "./profile-binding-service.js";
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
import { backfillPortableIds } from "./oyster-id-migration.js";

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
//   OYSTER_HOME — the user's Oyster workspace root. Always `~/Oyster/`
//     unless `OYSTER_USERLAND` overrides (e.g. an isolated worktree).
//     Dev mode and the installed package share one workspace by design —
//     `single-instance-lock` makes a second concurrent server impossible.
//   DB_DIR      — oyster.db, memory.db. At OYSTER_HOME/db/.
//   APPS_DIR    — installed app bundles (builtins + community). At OYSTER_HOME/apps/.
//   SPACES_DIR  — one folder per user space. At OYSTER_HOME/spaces/.
//   CONFIG_DIR  — reserved for future Oyster-specific config.
//   BACKUPS_DIR — snapshots. At OYSTER_HOME/backups/.
//
// opencode-ai's own config (opencode.json, .opencode/) stays at OYSTER_HOME
// root because opencode discovers it via CWD walk-up; moving it would
// require a spawn-flag change out of scope for this PR.
const OYSTER_HOME = process.env.OYSTER_USERLAND || join(homedir(), "Oyster");
const DB_DIR = join(OYSTER_HOME, "db");
const CONFIG_DIR = join(OYSTER_HOME, "config");
const APPS_DIR = join(OYSTER_HOME, "apps");
const SPACES_DIR = join(OYSTER_HOME, "spaces");
const BACKUPS_DIR = join(OYSTER_HOME, "backups");

// Retained for callsites that still pass the userland root down the stack
// (e.g. opencode-ai's spawn CWD, reconcileGeneratedArtifact's base path).
// Alias to OYSTER_HOME to minimise the surface of this PR.
const USERLAND_DIR = OYSTER_HOME;

// Dev handshake: write the actual bound port to ./.dev-port (repo root) so
// the Vite dev server proxies to *this* backend, not whichever Oyster
// happens to be on 3333. Lives at the repo root rather than under
// OYSTER_HOME because each worktree has its own checkout → its own file →
// no cross-talk, and so the file stays alongside `package.json`'s `npm run
// dev` wait-on. Removed on shutdown so a stale file fails loud (connection
// refused) rather than silent (talking to the wrong server). The pre-listen
// delete closes the race where wait-on would otherwise succeed against a
// crashed prior run's stale file. Declared up here (not next to listen())
// so the SIGTERM/SIGINT handlers registered below don't hit a const TDZ if
// a signal arrives mid-boot.
const DEV_PORT_FILE = join(PACKAGE_ROOT, ".dev-port");
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

// ── Single-instance lock ──
// Refuse to start if another Oyster server already owns this workspace.
// Stale locks (recorded pid is dead) are reclaimed automatically.
try {
  acquireLock(OYSTER_HOME);
} catch (err) {
  if (err instanceof AlreadyRunningError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

// ── Clean environment (no OpenAI key leak to subprocesses) ──

const cleanEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) cleanEnv[k] = v;
}
delete cleanEnv["OPENAI_API_KEY"];

// ── Artifact store ──

const db = bootTime("initDb (migrations)", () => initDb(DB_DIR));
backfillPortableIds(db);
const store = new SqliteArtifactStore(db);
const spaceStore = new SqliteSpaceStore(db);
const sessionStore = new SqliteSessionStore(db);
const WORKER_BASE = process.env.OYSTER_AUTH_BASE
  ? process.env.OYSTER_AUTH_BASE.replace(/\/auth$/, "")
  : "https://oyster.to";

const CLOUD_WORKER_BASE = process.env.OYSTER_CLOUD_BASE ?? "https://cloud.oyster.to";

// VIEWER_BASE is the public origin where /p/{token} renders (issue #397).
// In production it's a separate subdomain so untrusted published content
// can't read main-app cookies/storage. In local wrangler dev, the API and
// viewer paths are served from the same dev server, so default to
// WORKER_BASE when the explicit env var is unset and we're not on prod.
const VIEWER_BASE = process.env.OYSTER_VIEWER_BASE
  ?? (WORKER_BASE === "https://oyster.to" ? "https://share.oyster.to" : WORKER_BASE);

// artifactService reads the dedicated icons dir at `<root>/icons/<id>/icon.png`
// — that lives at OYSTER_HOME root (URL-addressable via /artifacts/icons/...),
// not inside DB_DIR. spaceStore is passed in so rowToArtifact can resolve the
// linked-source path for tiles whose `source_id` is non-null.
const artifactService = new ArtifactService(store, WORKER_BASE, VIEWER_BASE, OYSTER_HOME, spaceStore);

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

// Profile binding — locks this local profile to the first Pro account that
// signs in. Prevents a second Pro user from pulling their cloud data into
// the wrong local SQLite. canRunCloudSync() is the ONLY caller of bindToOwner.
const profileBinding = createProfileBindingService({ db });

// Device identity (#322 PR 2 hotfix). Seed the singleton on first boot so
// every session pushed to cloud carries which device it originated on.
// The device_id is a fresh uuid; the label is os.hostname() (e.g.
// "Matthews-MacBook-Pro.local") for human-readable display in PR 3's
// "Resumed from MacBook" chip. Stored in oyster.db so it survives
// app restarts and npm uninstall/install of oyster-os (npm doesn't touch
// the userland data dir). A factory-reset (deleting ~/Oyster/db/) creates
// a new device_id, which is the correct behaviour — that's effectively a
// new device.
//
// Backfill: if this is the FIRST seed (INSERT OR IGNORE actually inserted),
// mark every locally-known session with a cloud_owner_id as dirty so the
// next pushPending uploads them all with device_id attached. This is the
// one-shot migration that fills in device_id for sessions already in cloud
// from before this hotfix landed. The cost is one extra full push per
// existing user; subsequent boots short-circuit (INSERT OR IGNORE = no-op).
{
  const deviceSeed = db.prepare(
    `INSERT OR IGNORE INTO device_identity (id, device_id, label) VALUES (1, ?, ?)`,
  ).run(randomUUID(), hostname());
  if (deviceSeed.changes > 0) {
    const backfill = db.prepare(
      `UPDATE sessions SET sync_dirty_at = ? WHERE cloud_owner_id IS NOT NULL`,
    ).run(Date.now());
    if (backfill.changes > 0) {
      console.log(`[sessions] device_identity seeded; marked ${backfill.changes} sessions dirty for device_id backfill`);
    } else {
      console.log("[sessions] device_identity seeded (no prior sessions to backfill)");
    }
  }
}

// One-shot device_label backfill (PR 3.2a). The metadata-sync path stamps
// device_label on every outgoing push, but that only happens for sessions
// the push code actually drains — i.e. those whose sync_dirty_at is set.
// Sessions pushed before beta.9 have a NULL label in cloud and will stay
// that way until something else makes them dirty. Bump sync_dirty_at on
// all owned sessions exactly once so the next reconcile re-stamps every
// row with this device's label. Guarded via app_state so it runs once per
// install, not on every boot.
{
  const flag = db.prepare(
    `INSERT OR IGNORE INTO app_state (key, value, applied_at)
     VALUES ('device_label_backfill_done', '1', ?)`,
  ).run(Date.now());
  if (flag.changes > 0) {
    const bumped = db.prepare(
      `UPDATE sessions SET sync_dirty_at = ? WHERE cloud_owner_id IS NOT NULL`,
    ).run(Date.now());
    if (bumped.changes > 0) {
      console.log(`[sessions] device_label backfill: marked ${bumped.changes} sessions dirty for re-push`);
    }
  }
}

// Self-mirror cleanup (#322 PR 2 hotfix follow-up). Removes any
// remote_sessions rows that are actually local — either device_id matches
// this device, or session_id appears in the local `sessions` table. These
// ghosts arose during the device_id backfill: pull ran before push, cloud
// rows still had NULL device_id, so the old filter (device_id !== mine)
// failed to recognise them as self. Harmless thanks to the GET
// /api/sessions session_id de-dup, but better to remove the dead state so
// remote_sessions stays a faithful "other devices only" mirror.
//
// Idempotent — runs on every boot. The cost is O(remote_rows + local_rows)
// once at startup; negligible at typical scales.
{
  const cleaned = db.prepare(
    `DELETE FROM remote_sessions
      WHERE device_id = (SELECT device_id FROM device_identity WHERE id = 1)
         OR session_id IN (SELECT id FROM sessions)`,
  ).run();
  if (cleaned.changes > 0) {
    console.log(`[sessions] self-mirror cleanup: removed ${cleaned.changes} ghost remote_sessions rows`);
  }
}

/** Returns true when the signed-in user is Pro AND this local profile is
 *  either unbound or already bound to that user. Side-effect on first call
 *  for a new Pro user: binds the profile. */
function canRunCloudSync(): boolean {
  const u = authService.getState().user;
  if (!u || u.tier !== "pro") return false;

  const result = profileBinding.bindToOwner(u.id);
  if (!result.bound) {
    console.warn(
      `[profile] cloud sync blocked: profile bound to ${profileBinding.getBoundOwner()}, signed-in user is ${u.id} (${result.reason})`,
    );
    return false;
  }
  return true;
}

// spaceSync provides cross-device mirror of the spaces table to D1.
// Constructed before spaceService so the latter can fire pushOne/pushDelete
// after each mutation. Same auth bridge as publishService.
const spaceSync = createSpaceSyncService({
  db,
  store: spaceStore,
  profileBinding,
  currentUser: () => {
    const u = authService.getState().user;
    return u ? { id: u.id, email: u.email, tier: u.tier } : null;
  },
  sessionToken: () => authService.getState().sessionToken,
  workerBase: WORKER_BASE,
  fetch,
});

const memorySync: MemorySyncService = createMemorySyncService({
  db: memoryProvider.getInternalDbForSync(),
  provider: memoryProvider,
  profileBinding,                           // constructed in Task 4.4
  currentUser: () => {
    const u = authService.getState().user;
    return u ? { id: u.id, email: u.email, tier: u.tier } : null;
  },
  sessionToken: () => authService.getState().sessionToken,
  workerBase: CLOUD_WORKER_BASE,
  fetch: globalThis.fetch,
  onApplied: () => broadcastUiEvent({ version: 1, command: "memory_changed", payload: { op: "pull" } }),
});
memoryProvider.setOnWrite(() => {
  // Fire-and-forget. Catch any error so a transient sync failure can never
  // crash the server via unhandled rejection. pushPending swallows network
  // errors internally; this is belt-and-braces for unexpected throws.
  memorySync.pushPending().catch((err) => {
    console.warn("[memory] onWrite-triggered pushPending failed:", err);
  });
  // Notify the UI on every local mutation (remember/forget/purge). The
  // routes/memories.ts forget-DELETE used to be the only emitter; this
  // covers MCP-initiated remember and any other provider-level write path.
  broadcastUiEvent({ version: 1, command: "memory_changed", payload: { op: "write" } });
});

// Sessions arc — cross-device sync of agent sessions (#322). Two flows on
// the same service: metadata (markDirty + pushPending → D1) and bytes
// (pushBytes → chunked-delta uploads to R2 via worker). The watcher hook
// below marks rows dirty + fires pushBytes on terminal state. The 5-min
// snapshot timer (further below) drives mid-session bytes uploads.
// pull() + remote_sessions + resume API land in PR 2.
const sessionSync: SessionSyncService = createSessionSyncService({
  db,
  profileBinding,
  currentUser: () => {
    const u = authService.getState().user;
    return u ? { id: u.id, email: u.email, tier: u.tier } : null;
  },
  sessionToken: () => authService.getState().sessionToken,
  workerBase: CLOUD_WORKER_BASE,
  fetch: globalThis.fetch,
});

// Periodic pull. Pull-only triggers (auth-changed and app-startup) leave a
// running server stale until the next reconcile event. A modest 30s tick
// keeps cross-device memory updates fresh without burning excessive
// requests. Pro-only via canRunCloudSync (also covers profile-binding
// conflict). Configurable via OYSTER_SYNC_POLL_MS for ops/testing.
const MEMORY_POLL_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.OYSTER_SYNC_POLL_MS) || 30_000,
);
const memoryPollHandle = setInterval(() => {
  if (!canRunCloudSync()) return;
  memorySync.pull().then((applied) => {
    if (applied > 0) {
      console.log(`[memory] periodic pull: applied=${applied}`);
    }
  }).catch((err) => {
    console.warn("[memory] periodic pull failed:", err);
  });
  // Cross-device session metadata pull on the same tick (#322 PR 2 hotfix).
  // Without this, a running Oyster on Device B never sees sessions Device A
  // pushed after Device B's last sign-in / app-start. Memory had this loop
  // since 0.8.0; sessions need parity.
  sessionSync.pull().then((applied) => {
    if (applied > 0) {
      console.log(`[sessions] periodic pull: applied=${applied}`);
    }
  }).catch((err) => {
    console.warn("[sessions] periodic pull failed:", err);
  });
}, MEMORY_POLL_INTERVAL_MS);
memoryPollHandle.unref();

// Session bytes snapshot timer (#322). Every 5 minutes, scan
// active/waiting sessions whose disk file has grown by >= 1 MB beyond
// jsonl_snapshot_offset and fire pushBytes for each. The in-flight guard
// inside SessionSyncService coalesces with any concurrent terminal-hook
// push. Configurable via OYSTER_SESSIONS_SNAPSHOT_MS for ops/testing.
const SESSION_SNAPSHOT_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.OYSTER_SESSIONS_SNAPSHOT_MS) || 5 * 60_000,
);
const SESSION_SNAPSHOT_DELTA_THRESHOLD = Math.max(
  64 * 1024,
  Number(process.env.OYSTER_SESSIONS_SNAPSHOT_DELTA_BYTES) || 1024 * 1024,
);
async function runSessionsSnapshotTick(): Promise<void> {
  if (!canRunCloudSync()) return;
  // Candidates: active/waiting sessions owned by the current user. We
  // intentionally don't filter on file size in SQL because the database
  // doesn't know the current on-disk size — only the offset already uploaded.
  type Candidate = { id: string; cwd: string | null; jsonl_snapshot_offset: number };
  const candidates = db.prepare(
    `SELECT id, cwd, jsonl_snapshot_offset
       FROM sessions
      WHERE state IN ('active', 'waiting')
        AND cwd IS NOT NULL
        AND cloud_owner_id = ?`,
  ).all(authService.getState().user?.id ?? "") as Candidate[];
  if (candidates.length === 0) return;

  const root = projectsRoot();
  for (const cand of candidates) {
    if (!cand.cwd) continue;
    const jsonlPath = join(root, encodeCwd(cand.cwd), `${cand.id}.jsonl`);
    let size = 0;
    try {
      const st = statSync(jsonlPath);
      size = st.size;
    } catch {
      continue;  // file gone or unreadable; nothing to push
    }
    if (size - cand.jsonl_snapshot_offset < SESSION_SNAPSHOT_DELTA_THRESHOLD) continue;
    sessionSync.pushBytes(cand.id).catch((err) => {
      console.warn(`[sessions] snapshot pushBytes failed for ${cand.id}:`, err);
    });
  }
}
const sessionSnapshotHandle = setInterval(() => {
  runSessionsSnapshotTick().catch((err) => {
    console.warn("[sessions] snapshot tick failed:", err);
  });
}, SESSION_SNAPSHOT_INTERVAL_MS);
sessionSnapshotHandle.unref();

const spaceService = new SpaceService(spaceStore, store, artifactService, sessionStore, spaceSync);
const projectService = new ProjectService(db);
const sessionService = new SessionService(db, sessionStore, spaceStore);
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
  // Broadcast unconditionally — backfill may also CLEAR previously-surfaced
  // ghosts (skipped 3 → 0 because everything was unpublished elsewhere). The
  // surface needs a refetch in that case too, even though both counters are
  // zero. Refetch is cheap; keeping a stale pill is the worse failure mode.
  broadcastUiEvent({ version: 1, command: "artifact_changed", payload: { id: null } });
}

// Wire the cloud-only publication source into artifact-service so ghosts
// appear in /api/artifacts. Done after both services exist; the source
// itself is just a getter on publish-service.
artifactService.setCloudOnlyPublicationsSource(() => publishService.getCloudOnlyPublications());

async function syncOnAuth(label: string): Promise<void> {
  // Spaces sync is gated: Pro-only, and the profile must be unbound or already
  // bound to this user. canRunCloudSync() is also the sole production caller of
  // bindToOwner — first Pro sign-in binds the profile here as a side effect.
  // publishService.backfillPublications() is NOT gated: it runs for any
  // signed-in user (free or Pro) and handles sign-out cleanup internally.
  if (canRunCloudSync()) {
    // Spaces FIRST — the headline fix of #406 is that published-artefact
    // ghosts resolve to real spaces, not _cloud. Doing publications first
    // defeats that — the ghost render would still fall through to _cloud
    // until the *next* sign-in. spaces first → publications second → render.
    try {
      const sr = await spaceSync.reconcile();
      console.log(`[spaces] ${label}: pulled=${sr.pulled} pushed=${sr.pushed} tombstoned=${sr.tombstoned}`);
      if (sr.pulled > 0 || sr.tombstoned > 0) {
        // Notify the surface so any space pills update immediately.
        broadcastUiEvent({ version: 1, command: "artifact_changed", payload: { id: null } });
      }
    } catch (err) {
      console.warn(`[spaces] ${label} failed:`, err);
    }
    try {
      const memResult = await memorySync.reconcile();
      if (memResult.pulled || memResult.pushed) {
        console.log(`[memory] reconcile (${label}): pulled=${memResult.pulled} pushed=${memResult.pushed}`);
      }
    } catch (err) {
      console.warn(`[memory] ${label} reconcile failed:`, err);
    }
    try {
      const sesResult = await sessionSync.reconcile();
      if (sesResult.pulled || sesResult.pushed) {
        console.log(`[sessions] reconcile (${label}): pulled=${sesResult.pulled} pushed=${sesResult.pushed}`);
      }
    } catch (err) {
      console.warn(`[sessions] ${label} reconcile failed:`, err);
    }
  }
  // Then publications (preserves existing behaviour: clears ghost cache on
  // sign-out, broadcasts artifact_changed unconditionally via logBackfill).
  const pr = await publishService.backfillPublications();
  logBackfill(label, pr);
}

authService.onAuthChanged(() => { void syncOnAuth("auth"); });
if (authService.getState().user) {
  void syncOnAuth("startup");
}

// ── Initialize subsystems ──

const pendingReveals = new Set<string>();

// PTY shell is lazy-spawned on first WebSocket connection (i.e. when the
// user opens the terminal window). Spawning eagerly here doubled boot time
// because two opencode-ai processes competed for CPU during init. See #385.

bootMark("subsystems init done (artifactService, spaceService, authService, publishService)");

// OpenCode spawn is deferred until after port resolution (see below)
// Scan every location where app bundles can live after #207:
//   APPS_DIR               — installed builtins + community apps
//   SPACES_DIR/<space>/    — AI-generated apps owned by a space
//   OYSTER_HOME            — anything still at the root (legacy / newly-generated
//                            before the agent's CWD gets re-pointed in a follow-up)
bootTime("scanExistingArtifacts (apps + spaces + home)", () => {
  scanExistingArtifacts(APPS_DIR);
  if (existsSync(SPACES_DIR)) {
    for (const spaceEntry of readdirSync(SPACES_DIR)) {
      const spaceDir = join(SPACES_DIR, spaceEntry);
      try {
        // manifestOnly: true — space folders contain organisational
        // subfolders (invoices/, research/) with many single-file artifacts.
        // The fallback scan would misregister each subfolder as a bogus
        // gen:<folder> bundle; only manifest-based AI-generated apps
        // should be picked up here.
        if (statSync(spaceDir).isDirectory()) scanExistingArtifacts(spaceDir, { manifestOnly: true });
      } catch { /* skip unreadable */ }
    }
  }
  scanExistingArtifacts(ARTIFACTS_DIR);
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

startGenerationTimer((id, filePath, builtin) => {
  if (!builtin) {
    const entry = getGeneratedArtifactEntries().find(e => e.id === id);
    if (entry) artifactService.reconcileGeneratedArtifact(entry, filePath, USERLAND_DIR);
  }
});
startAutoApprover(getOpenCodePort, (file) => handleFileEdited(file, ARTIFACTS_DIR));

// Shutdown cleanup. Wrap each step so a throw in (say) killOpenCode doesn't
// stop the dev-port file and the workspace lock from being cleared — a stale
// lock left behind is more annoying than the failure that triggered the exit.
function shutdown(code: number): never {
  markShuttingDown();
  try { killOpenCode(); } catch { /* best effort */ }
  try { db.close(); } catch { /* best effort */ }
  try { memoryProvider.close(); } catch { /* best effort */ }
  try { clearDevPortFile(); } catch { /* best effort */ }
  try { releaseLock(OYSTER_HOME); } catch { /* best effort */ }
  process.exit(code);
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("uncaughtException", (err) => {
  console.error(`[oyster] uncaught exception: ${err.message}`);
  // Fail fast — the server is in an unknown state with opencode-ai dead and
  // restart disabled. Exiting non-zero lets the user restart cleanly rather
  // than leaving a zombie that silently drops every chat message.
  shutdown(1);
});
process.on("unhandledRejection", (err) => {
  console.error(`[oyster] unhandled rejection: ${err instanceof Error ? err.message : err}`);
  shutdown(1);
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

  const resolveCurrentOwnerId = (): string | null => {
    const u = authService.getState().user;
    return u?.tier === "pro" ? u.id : null;
  };

  // /api/sessions/* — first extracted route bucket. Returns true when
  // handled; falls through if no session route matched.
  if (await tryHandleSessionRoute(req, res, url, ctx, {
    db, sessionStore, spaceStore, artifactService, memoryProvider, sessionSync,
    currentUserId: () => authService.getState().user?.id ?? null,
    sessionService, broadcastUiEvent,
  })) return;

  // /api/artifacts/*, /api/groups/*, /api/plugins/:id/uninstall.
  if (await tryHandleArtifactRoute(req, res, url, ctx, {
    artifactService, sessionStore, pendingReveals,
    clearSeenArtifact, OYSTER_HOME, APPS_DIR, SPACES_DIR, publishService,
  })) return;

  // /api/projects/* — projects identity surface (replaces /api/spaces/:id/sources*
  // during the sources→projects cut).
  if (await tryHandleProjectsRoute(req, res, url, ctx, {
    projectService, broadcastUiEvent,
  })) return;

  // /api/spaces/* — collapsed from the legacy spaces-routes.ts and the
  // inline /api/spaces/:id/sources* + /api/spaces/from-path handlers.
  if (await tryHandleSpaceRoute(req, res, url, ctx, {
    spaceService, projectService, broadcastUiEvent,
  })) return;

  // /api/setup/apply — fans the user's confirmed SetupProposal out to
  // createSpace + attachFolder. Triggered by the SetupProposalPanel's Apply button.
  if (await tryHandleSetupRoute(req, res, url, ctx, {
    spaceService, projectService, broadcastUiEvent,
  })) return;

  // /api/memories
  if (await tryHandleMemoryRoute(req, res, url, ctx, {
    memoryProvider,
    resolveCurrentOwnerId,
    memorySync,
  })) return;

  // /api/auth/* — local glue (whoami / startSignIn / signOut). Real auth
  // (magic-link, OAuth) lives in the Cloudflare Worker.
  if (await tryHandleAuthRoute(req, res, url, ctx, { authService })) return;

  // /api/artifacts/:id/publish — publish + unpublish an artefact.
  if (await tryHandlePublishRoute(req, res, url, ctx, { publishService, broadcastUiEvent })) return;

  // /api/artifacts/:id/pin — pin / unpin an artefact (#387).
  if (await tryHandlePinRoute(req, res, url, ctx, { artifactService, broadcastUiEvent })) return;

  // /api/device/identity — local device UUID + label for the cross-device UI chip.
  if (await tryHandleDeviceRoute(req, res, url, ctx, { db })) return;

  // /oauth/*, /.well-known/oauth-*, /mcp/*, /api/mcp/status
  // Pass the actually-bound `port`, not PREFERRED_PORT — findPort() may
  // have rolled forward (e.g. main repo's dev server already on 3333),
  // and the OAuth discovery + redirect URLs must advertise the real port.
  if (await tryHandleOAuthMcpRoute(req, res, url, ctx, {
    port,
    store, artifactService, spaceService, projectService, sessionService, memoryProvider,
    sessionStore, pendingReveals, broadcastUiEvent,
    userlandDir: USERLAND_DIR,
    getNativeSourcePath,
    publishService,
    resolveCurrentOwnerId,
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
setLockPort(OYSTER_HOME, port);

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

  // Debounce-with-max-wait for metadata push. The watcher fires
  // emitSessionChanged on every jsonl event (assistant turn, tool call,
  // etc.) — during a busy conversation that's many events per minute.
  // Without coalescing, each event triggers its own pushPending → its own
  // HTTP round-trip with one session in the payload
  // (`[sessions] pushed: accepted=1` spam in logs).
  //
  // markDirty stays synchronous so durability is intact: any unpushed
  // session_id keeps its sync_dirty_at marker and is drained by the next
  // push or the next startup reconcile.
  //
  // Two timing knobs:
  // - DEBOUNCE_MS (1 s): how long after the LAST event we wait before
  //   firing. Coalesces a quick burst of events into a single push at the
  //   tail of the burst.
  // - MAX_WAIT_MS (5 s): hard cap on how long the first-event-in-burst
  //   waits, no matter how many further events arrive. Without this, a
  //   pure debounce can defer pushes arbitrarily during continuous
  //   activity — bad for cross-device visibility during long sessions.
  //
  // Terminal-state pushBytes is unaffected — it fires immediately so a
  // session ending lands its last bytes ASAP.
  const SESSION_PUSH_DEBOUNCE_MS = 1000;
  const SESSION_PUSH_MAX_WAIT_MS = 5000;
  let sessionPushTimer: NodeJS.Timeout | null = null;
  let sessionPushFirstScheduledAt: number | null = null;
  function schedulePushPending(): void {
    const now = Date.now();
    if (sessionPushFirstScheduledAt === null) {
      sessionPushFirstScheduledAt = now;
    }
    // Cap the actual sleep so the first-scheduled event fires within
    // MAX_WAIT_MS even if events keep arriving. Math.max(0, ...) handles
    // the "already past the cap" case (next-tick fire).
    const elapsed = now - sessionPushFirstScheduledAt;
    const delay = Math.max(0, Math.min(SESSION_PUSH_DEBOUNCE_MS, SESSION_PUSH_MAX_WAIT_MS - elapsed));
    if (sessionPushTimer) clearTimeout(sessionPushTimer);
    sessionPushTimer = setTimeout(() => {
      sessionPushTimer = null;
      sessionPushFirstScheduledAt = null;
      sessionSync.pushPending().catch((err) => {
        console.warn("[sessions] watcher-triggered pushPending failed:", err);
      });
    }, delay);
  }

  const claudeCodeWatcher = new ClaudeCodeWatcher({
    sessionStore,
    spaceStore,
    artifactStore: store,
    lookupProject: (cwd) => lookupProject(db, cwd),
    emitSessionChanged: (id) => {
      broadcastUiEvent({ version: 1, command: "session_changed", payload: { id } });
      // Cross-device session sync (#322): every session-row change marks the
      // row dirty for the current Pro owner, then schedules a debounced
      // metadata push. Bytes push on terminal state stays immediate so the
      // last chunk lands ASAP.
      //
      // canRunCloudSync() (not a bare tier check): when the local profile is
      // bound to a different account, we MUST NOT call markDirty — it would
      // overwrite cloud_owner_id to the wrong owner and the rightful bound
      // owner's later pushPending would no longer find these rows in the
      // owner-scoped scan.
      if (!canRunCloudSync()) return;
      const u = authService.getState().user!;
      sessionSync.markDirty(id, u.id);
      schedulePushPending();
      // Terminal-state hook: fire one final pushBytes when the session
      // transitions to done/disconnected so the tail of the jsonl makes it
      // to cloud even if it's under the snapshot-timer's 1 MB threshold.
      // sessionStore lookup is a single PK read — cheap.
      const row = sessionStore.getById(id);
      if (row && (row.state === "done" || row.state === "disconnected")) {
        sessionSync.pushBytes(id).catch((err) => {
          console.warn("[sessions] terminal pushBytes failed:", err);
        });
      }
    },
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
