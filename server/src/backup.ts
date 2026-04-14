import { existsSync, mkdirSync, cpSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const MAX_BACKUPS = 5;

function getAppVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch {
    return "unknown";
  }
}

/**
 * Auto-backup userland on startup.
 * Copies the entire userland directory (DB, artifacts, icons, configs)
 * to ~/oyster-backups/auto/backup-{timestamp}/.
 * Rotates old auto backups, keeping the last 5. Never touches manual backups.
 */
export function runStartupBackup(userlandDir: string): void {
  if (!existsSync(userlandDir)) return;
  if (!existsSync(join(userlandDir, "oyster.db"))) return;

  const autoDir = join(homedir(), "oyster-backups", "auto");
  mkdirSync(autoDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(autoDir, `backup-${timestamp}`);

  try {
    cpSync(userlandDir, dest, { recursive: true });
    writeFileSync(join(dest, "backup.json"), JSON.stringify({
      type: "auto",
      created_at: new Date().toISOString(),
      app_version: getAppVersion(),
    }, null, 2) + "\n");
    console.log(`[backup] saved → ${dest}`);
  } catch (err) {
    console.error("[backup] failed:", err);
    return;
  }

  // Rotate: keep only the most recent MAX_BACKUPS in auto/
  try {
    const entries = readdirSync(autoDir)
      .filter((e) => e.startsWith("backup-"))
      .map((e) => ({ name: e, time: statSync(join(autoDir, e)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    for (const old of entries.slice(MAX_BACKUPS)) {
      rmSync(join(autoDir, old.name), { recursive: true, force: true });
      console.log(`[backup] rotated out ${old.name}`);
    }
  } catch (err) {
    console.error("[backup] rotation failed:", err);
  }
}
