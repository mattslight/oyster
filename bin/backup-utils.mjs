import { existsSync, cpSync, mkdirSync, realpathSync, renameSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const OYSTER_HOME = join(homedir(), ".oyster");
const BACKUPS_DIR = join(homedir(), "oyster-backups");
const PID_FILE = join(OYSTER_HOME, "oyster.pid");

function getAppVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function writeManifest(dir, type) {
  const manifest = {
    type,
    created_at: new Date().toISOString(),
    app_version: getAppVersion(),
  };
  writeFileSync(join(dir, "backup.json"), JSON.stringify(manifest, null, 2) + "\n");
}

export function resolveUserlandDir() {
  if (process.env.OYSTER_USERLAND) return process.env.OYSTER_USERLAND;
  const installed = join(OYSTER_HOME, "userland");
  if (existsSync(join(installed, "oyster.db"))) return installed;
  const local = join(PACKAGE_ROOT, "userland");
  if (existsSync(join(local, "oyster.db"))) return local;
  return installed; // default for fresh installs
}

export function isOysterRunning() {
  if (process.argv.includes("--force")) return false;
  if (!existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    // Process is dead — clean up stale PID file
    try { unlinkSync(PID_FILE); } catch {}
    return false;
  }
}

export function createManualBackup(userlandDir) {
  if (isOysterRunning()) {
    console.error("  Error: Oyster is running. Stop it first, then retry.\n  If this is a stale PID, use --force to override.");
    process.exit(1);
  }

  if (!existsSync(join(userlandDir, "oyster.db"))) {
    console.error(`  Error: Nothing to back up — no database found at ${userlandDir}`);
    process.exit(1);
  }

  mkdirSync(BACKUPS_DIR, { recursive: true });
  const dest = join(BACKUPS_DIR, `backup-${timestamp()}`);

  cpSync(userlandDir, dest, { recursive: true });
  writeManifest(dest, "manual");

  console.log(`\n  Backup saved → ${dest}\n`);
  return dest;
}

export function restoreBackup(sourcePath, userlandDir) {
  if (isOysterRunning()) {
    console.error("  Error: Oyster is running. Stop it first, then retry.\n  If this is a stale PID, use --force to override.");
    process.exit(1);
  }

  const resolved = resolve(sourcePath);
  if (!existsSync(resolved)) {
    console.error(`  Error: Backup not found at ${resolved}`);
    process.exit(1);
  }

  if (!existsSync(join(resolved, "oyster.db"))) {
    console.error(`  Error: ${resolved} doesn't look like a backup (no oyster.db)`);
    process.exit(1);
  }

  // Self-restore check via realpath
  if (existsSync(userlandDir)) {
    try {
      if (realpathSync(resolved) === realpathSync(userlandDir)) {
        console.error("  Error: Can't restore userland onto itself.");
        process.exit(1);
      }
    } catch {}
  }

  // Safety backup of current state (straight copy — Oyster is not running)
  if (existsSync(join(userlandDir, "oyster.db"))) {
    mkdirSync(BACKUPS_DIR, { recursive: true });
    const safetyDest = join(BACKUPS_DIR, `pre-restore-${timestamp()}`);
    cpSync(userlandDir, safetyDest, { recursive: true });
    writeManifest(safetyDest, "pre-restore");
    console.log(`\n  Current state saved → ${safetyDest}`);
  }

  // Stage: copy source to a sibling temp dir (same filesystem for atomic rename)
  const ts = timestamp();
  const tempDir = `${userlandDir}.restoring-${ts}`;
  cpSync(resolved, tempDir, { recursive: true });

  // Verify staged copy
  if (!existsSync(join(tempDir, "oyster.db"))) {
    console.error("  Error: Staged restore is missing oyster.db. Aborting.");
    process.exit(1);
  }

  // Swap: rename current out, rename temp in
  const oldDir = `${userlandDir}.old-${ts}`;
  if (existsSync(userlandDir)) {
    renameSync(userlandDir, oldDir);
  }
  renameSync(tempDir, userlandDir);

  // Clean up the old directory
  try {
    rmSync(oldDir, { recursive: true, force: true });
  } catch {}

  console.log(`  Restored from  → ${resolved}`);
  console.log(`  Userland now at → ${userlandDir}\n`);
}
