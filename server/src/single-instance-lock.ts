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
//
// Atomicity: creation goes through `openSync(path, "wx")` (O_EXCL) so two
// processes starting at the same moment can't both win. Updates (setLockPort)
// write to a sibling temp file and `renameSync` over the lock, which is an
// atomic replace on POSIX and Windows alike — readers never see a torn file.

import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
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

function writeLockExclusive(path: string, data: LockData): void {
  // "wx" = create-and-fail-if-exists, atomic at the syscall level. The
  // EEXIST signal is what lets us detect the race in acquireLock.
  const fd = openSync(path, "wx");
  try {
    writeSync(fd, JSON.stringify(data));
  } finally {
    closeSync(fd);
  }
}

export class AlreadyRunningError extends Error {
  constructor(public existing: LockData, workspaceDir: string) {
    const portStr = existing.port != null ? ` on port ${existing.port}` : "";
    super(
      `Oyster is already running${portStr} (pid ${existing.pid}).\n` +
      `Workspace: ${workspaceDir}\n` +
      `Quit the running instance before starting another.`,
    );
    this.name = "AlreadyRunningError";
  }
}

export function acquireLock(workspaceDir: string): void {
  const path = lockPath(workspaceDir);
  const data: LockData = { pid: process.pid, port: null, startedAt: new Date().toISOString() };
  // Two attempts is enough: the first either succeeds (no lock) or surfaces
  // an existing lock. If that existing lock is stale (pid dead) we unlink
  // and retry once. A still-alive lock the second time would only happen
  // if a third process raced in between — at that point we honour it and
  // refuse, which is the correct outcome.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeLockExclusive(path, data);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const existing = readLock(workspaceDir);
      if (existing && isPidAlive(existing.pid) && existing.pid !== process.pid) {
        throw new AlreadyRunningError(existing, workspaceDir);
      }
      // Stale or unreadable lock — unlink and retry. Unlink itself can race
      // (another process clears it first); ENOENT is fine.
      try { unlinkSync(path); } catch (rmErr) {
        if ((rmErr as NodeJS.ErrnoException).code !== "ENOENT") throw rmErr;
      }
    }
  }
  // Two consecutive EEXISTs with a live-looking lock on the second read:
  // give the second one priority and refuse, even though we don't have
  // a parsed LockData (readLock returned null at that point).
  const last = readLock(workspaceDir);
  if (last && isPidAlive(last.pid) && last.pid !== process.pid) {
    throw new AlreadyRunningError(last, workspaceDir);
  }
}

export function setLockPort(workspaceDir: string, port: number): void {
  const data = readLock(workspaceDir);
  if (!data || data.pid !== process.pid) return;
  const target = lockPath(workspaceDir);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    // Write whole file to a sibling tmp path, then atomic rename. Readers
    // either see the old contents or the new contents — never a partial
    // file. The pid suffix on the tmp filename keeps two unrelated workers
    // from clobbering each other's tmp (defensive; in practice only one
    // process ever owns this lock).
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify({ ...data, port } satisfies LockData));
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch {
    try { unlinkSync(tmp); } catch { /* tmp may not exist */ }
    /* non-fatal: the error message just won't include the port */
  }
}

export function releaseLock(workspaceDir: string): void {
  const data = readLock(workspaceDir);
  if (!data || data.pid !== process.pid) return;
  try { unlinkSync(lockPath(workspaceDir)); } catch { /* non-fatal */ }
}
