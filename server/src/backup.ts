import { existsSync, mkdirSync, cpSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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
 * Auto-backup userland on startup (best-effort — never crashes the server).
 * Copies the entire userland directory (DB, artifacts, icons, configs)
 * to ~/oyster-backups/auto/backup-{date}/. One backup per day.
 * Rotates old auto backups, keeping the last 5 days.
 */
export function runStartupBackup(userlandDir: string): void {
  if (!existsSync(userlandDir)) return;
  if (!existsSync(join(userlandDir, "oyster.db"))) return;

  try {
    const isDev = !userlandDir.includes(join(homedir(), ".oyster"));
    const autoDir = isDev
      ? join(homedir(), "oyster-backups", "dev")
      : join(homedir(), "oyster-backups", "auto");
    mkdirSync(autoDir, { recursive: true });

    // One backup per day — stable name per date
    const today = new Date().toISOString().slice(0, 10); // "2026-04-14"
    const dest = join(autoDir, `backup-${today}`);

    if (existsSync(dest)) {
      console.log(`[backup] already backed up today (backup-${today}), skipping`);
      return;
    }

    cpSync(userlandDir, dest, { recursive: true });
    writeFileSync(join(dest, "backup.json"), JSON.stringify({
      type: "auto",
      created_at: new Date().toISOString(),
      app_version: getAppVersion(),
    }, null, 2) + "\n");
    console.log(`[backup] saved → ${dest}`);

    // Rotate: keep only the most recent MAX_BACKUPS in auto/
    const entries = readdirSync(autoDir)
      .filter((e) => e.startsWith("backup-"))
      .sort()
      .reverse();

    for (const old of entries.slice(MAX_BACKUPS)) {
      rmSync(join(autoDir, old), { recursive: true, force: true });
      console.log(`[backup] rotated out ${old}`);
    }
  } catch (err) {
    console.warn("[backup] ⚠ auto-backup failed — your data is NOT backed up. Error:", err);
  }
}
