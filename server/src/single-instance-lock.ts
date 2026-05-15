// Single-instance enforcement per workspace.
//
// Two Oyster servers writing to the same `~/Oyster/` would race on the SQLite
// WAL, double-spawn the OpenCode subprocess, and fight over the .dev-port
// handshake file. The lock makes this structurally impossible: at boot we
// write `<workspace>/.oyster.lock` with our pid; if a live process already
// holds it, we refuse to start. Stale locks (pid is dead) are reclaimed.
//
// Pair `acquireLock` once at startup (after bootstrapUserland, before initDb)
// with `releaseLock` in the SIGTERM/SIGINT handlers. `setLockPort` is best-
// effort and just lets the "already running" message print the bound port
// instead of `null`.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_FILE = ".oyster.lock";

interface LockData {
  pid: number;
  port: number | null;
  startedAt: string;
}

function lockPath(workspaceDir: string): string {
  return join(workspaceDir, LOCK_FILE);
}

function readLock(workspaceDir: string): LockData | null {
  const p = lockPath(workspaceDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as LockData;
  } catch {
    return null;
  }
}

// `process.kill(pid, 0)` doesn't send a signal — it just probes whether the
// pid is reachable. EPERM means "exists but we can't signal it" (different
// user, sandbox); count that as alive too. ESRCH means the pid is gone.
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class AlreadyRunningError extends Error {
  constructor(public existing: LockData, workspaceDir: string) {
    const portStr = existing.port ? ` on port ${existing.port}` : "";
    super(
      `Oyster is already running${portStr} (pid ${existing.pid}).\n` +
      `Workspace: ${workspaceDir}\n` +
      `Quit the running instance before starting another.`,
    );
    this.name = "AlreadyRunningError";
  }
}

export function acquireLock(workspaceDir: string): void {
  const existing = readLock(workspaceDir);
  if (existing && isPidAlive(existing.pid) && existing.pid !== process.pid) {
    throw new AlreadyRunningError(existing, workspaceDir);
  }
  writeFileSync(
    lockPath(workspaceDir),
    JSON.stringify({ pid: process.pid, port: null, startedAt: new Date().toISOString() } satisfies LockData),
    "utf8",
  );
}

export function setLockPort(workspaceDir: string, port: number): void {
  const data = readLock(workspaceDir);
  if (!data || data.pid !== process.pid) return;
  try {
    writeFileSync(lockPath(workspaceDir), JSON.stringify({ ...data, port } satisfies LockData), "utf8");
  } catch { /* non-fatal */ }
}

export function releaseLock(workspaceDir: string): void {
  const data = readLock(workspaceDir);
  if (!data || data.pid !== process.pid) return;
  try { unlinkSync(lockPath(workspaceDir)); } catch { /* non-fatal */ }
}
