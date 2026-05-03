// Vault inventory — file/DB introspection for the Pro "Vault" page.
//
// Extracted from index.ts so the route module stays purely about HTTP
// dispatch. Pure functions of (paths, db, spaceStore); the cache is
// process-local module state.
//
// The walk visits every file under OYSTER_HOME plus the backups tree —
// easily seconds on a real install (large WAL, many spaces). Repeat hits
// within VAULT_INVENTORY_TTL_MS reuse the last result so a user idly
// looking at the Pro page doesn't grind the disk on every re-render.

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { SqliteSpaceStore } from "./space-store.js";

export interface VaultInventoryEntry {
  name: string;
  label: string;
  description: string;
  count: number;
  unit: string;
  size: number;
  exists: boolean;
  meta?: string;
}

export interface VaultInventoryLayout {
  oysterHome: string;
  spacesDir: string;
  appsDir: string;
  dbDir: string;
  configDir: string;
}

export interface VaultInventoryResult {
  root: string;
  totalSize: number;
  entries: VaultInventoryEntry[];
}

const VAULT_INVENTORY_TTL_MS = 30_000;

let cache: { result: VaultInventoryResult; expires: number } | null = null;

/** Drop the memoised result. SSE events that change the inventory
 *  (artefact CRUD, source attach/detach) can call this so the next
 *  request rebuilds. Currently no callers — wired up here for when the
 *  cache invalidation policy gets formalised (#…). */
export function invalidateVaultInventoryCache(): void { cache = null; }

/** Cached front for buildVaultInventory — first call within
 *  VAULT_INVENTORY_TTL_MS does the walk; subsequent calls reuse it. */
export function getVaultInventory(deps: {
  layout: VaultInventoryLayout;
  db: Database.Database;
  spaceStore: SqliteSpaceStore;
}): VaultInventoryResult {
  const now = Date.now();
  if (!cache || cache.expires <= now) {
    const entries = buildVaultInventory(deps);
    const totalSize = entries.reduce((acc, r) => acc + r.size, 0);
    cache = {
      result: {
        root: humanizeHome(deps.layout.oysterHome),
        totalSize,
        entries,
      },
      expires: now + VAULT_INVENTORY_TTL_MS,
    };
  }
  return cache.result;
}

// ── internals ────────────────────────────────────────────────────────

// Render the absolute OYSTER_HOME with the user's home dir collapsed to
// `~/` for display — keeps the Vault page header readable on shared
// screenshots without leaking the macOS username.
function humanizeHome(p: string): string {
  const h = homedir();
  return p.startsWith(h) ? "~" + p.slice(h.length) : p;
}

// Recursive size walker. Counts file sizes only (directories are
// containers, not bytes) and skips symlinks to avoid loops. Swallows
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

// Count immediate subdirectories. Used for Apps (one bundle = one
// directory) and Backups (one snapshot = one directory or file).
function countTopEntries(dir: string, opts: { dirsOnly?: boolean } = {}): number {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return opts.dirsOnly ? entries.filter((e) => e.isDirectory()).length : entries.length;
  } catch { return 0; }
}

function buildVaultInventory(deps: {
  layout: VaultInventoryLayout;
  db: Database.Database;
  spaceStore: SqliteSpaceStore;
}): VaultInventoryEntry[] {
  const { layout, db, spaceStore } = deps;
  const { oysterHome, spacesDir, appsDir, dbDir, configDir } = layout;
  const out: VaultInventoryEntry[] = [];

  // Spaces — DB rows are the source of truth (a space can have a repo_path
  // pointing outside SPACES_DIR). The on-disk SPACES_DIR is just where
  // native AI-generated artefacts land.
  const spaceCount = spaceStore.getAll()
    .filter((s) => s.id !== "home" && s.id !== "__all__" && s.id !== "__archived__")
    .length;
  out.push({
    name: "spaces",
    label: "Spaces",
    description: "Your projects and workspaces",
    count: spaceCount,
    unit: "space",
    size: existsSync(spacesDir) ? walkDirSize(spacesDir).size : 0,
    exists: existsSync(spacesDir),
  });

  // Apps — count bundles (top-level directories), not the recursive file
  // count. A bundle is the unit users actually think about.
  out.push({
    name: "apps",
    label: "Apps",
    description: "Installed plugin bundles",
    count: countTopEntries(appsDir, { dirsOnly: true }),
    unit: "bundle",
    size: existsSync(appsDir) ? walkDirSize(appsDir).size : 0,
    exists: existsSync(appsDir),
  });

  // Database — row count, not file count. Sums the user-facing tables
  // across both oyster.db and memory.db. SQL is wrapped in try/catch so
  // a missing table (e.g. on a fresh install) doesn't break the endpoint.
  let dbRows = 0;
  const tables = ["artifacts", "spaces", "sources", "sessions", "session_events", "session_artifacts"];
  for (const t of tables) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number } | undefined;
      if (row) dbRows += row.n;
    } catch { /* table missing — skip */ }
  }
  // Memories live in a separate DB file; open read-only so a busy WAL
  // can't block us.
  try {
    const memDbPath = join(dbDir, "memory.db");
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
    size: existsSync(dbDir) ? walkDirSize(dbDir).size : 0,
    exists: existsSync(dbDir),
  });

  // Config — opencode-ai's config lives at OYSTER_HOME root (opencode.json
  // and the .opencode/ overrides), not under CONFIG_DIR. Count those files
  // directly so the row reflects what's actually configured.
  let configCount = 0;
  let configSize = 0;
  const opencodeJson = join(oysterHome, "opencode.json");
  if (existsSync(opencodeJson)) {
    try { configCount += 1; configSize += statSync(opencodeJson).size; } catch { /* skip */ }
  }
  const dotOpencode = join(oysterHome, ".opencode");
  if (existsSync(dotOpencode)) {
    const w = walkDirSize(dotOpencode);
    configCount += w.count; configSize += w.size;
  }
  if (existsSync(configDir)) {
    const w = walkDirSize(configDir);
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
