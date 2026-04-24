import { existsSync, mkdirSync, cpSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
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
 *
 * Post-#207: the DB now lives at `<root>/db/oyster.db`. This function
 * also accepts the legacy `<root>/oyster.db` location so old installs
 * still get backed up if anyone runs them. Dev-vs-installed detection
 * now covers both `~/Oyster/` (installed, new) and `~/.oyster/userland/`
 * (installed, pre-migration) — anything else is treated as dev.
 */
export function runStartupBackup(userlandDir: string): void {
  if (!existsSync(userlandDir)) return;
  // DB might be at the flat root (legacy) or inside db/ (post-#207).
  // If neither exists, there's nothing to back up.
  const hasDb = existsSync(join(userlandDir, "db", "oyster.db"))
             || existsSync(join(userlandDir, "oyster.db"));
  if (!hasDb) return;

  try {
    // Normalise both sides so the installed-vs-dev check is path-separator
    // agnostic (Windows uses `\`, POSIX uses `/`). Without resolve() a
    // Windows installed path (`C:\Users\x\Oyster`) wouldn't match the
    // "installed" prefix check against a POSIX-style string and backups
    // would silently go to the dev folder.
    const normUserland = resolve(userlandDir);
    const installedRoots = [
      resolve(join(homedir(), "Oyster")),             // post-#207 installed
      resolve(join(homedir(), ".oyster", "userland")), // pre-migration installed
    ];
    const isInstalled = installedRoots.some((r) => normUserland === r || normUserland.startsWith(r + sep));
    const autoDir = isInstalled
      ? join(homedir(), "oyster-backups", "auto")
      : join(homedir(), "oyster-backups", "dev");
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
