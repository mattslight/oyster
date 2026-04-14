import { existsSync, mkdirSync, cpSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const MAX_BACKUPS = 5;

function getAppVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8"));
        if (pkg.name === "oyster-os") return pkg.version;
      }
      dir = dirname(dir);
    }
    return "unknown";
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

  // One backup per day — if today already has one, skip
  const today = new Date().toISOString().slice(0, 10); // "2026-04-14"
  const existing = readdirSync(autoDir).filter((e) => e.startsWith(`backup-${today}`));
  if (existing.length > 0) {
    console.log(`[backup] already backed up today (${existing[0]}), skipping`);
    return;
  }

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
