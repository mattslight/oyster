import { exec } from "node:child_process";
import { promisify } from "node:util";

const execP = promisify(exec);

// Discover the working directories of every running `claude` process.
//
// The trick: every running process has a current working directory, and
// claude-code runs in the same cwd that gets recorded in its JSONL session
// file. So if `pgrep` finds a `claude` PID and `lsof -p <pid> -a -d cwd`
// reports a cwd that matches a session's recorded cwd, that session has a
// live process behind it. No IPC, no file-handle racing, no per-agent SDK.
//
// Cost: ~40ms wall clock for 1-5 claude processes on macOS. The probe runs
// on the watcher heartbeat (every 15s), so a few hundred ms/min of subprocess
// time at the high end. Fine.
//
// Cross-platform note: pgrep + lsof are POSIX-only. On Windows (or any
// system without pgrep), `available: false` is returned and the watcher
// falls back to JSONL-recency-only state derivation. Tracked separately —
// see issue #268.
//
// `counts` is per-cwd because two claude processes can share a cwd
// (worktrees, pair-programming, parallel investigations). The heartbeat
// uses count > 0 today; the per-cwd structure leaves room for a finer
// matching strategy later if we revisit per-PID identity.
export interface ClaudeProbeResult {
  counts: Map<string, number>;
  available: boolean;
}

export async function activeClaudeCwdCounts(): Promise<ClaudeProbeResult> {
  let pidsOut: string;
  try {
    const result = await execP("pgrep -x claude", { timeout: 2000 });
    pidsOut = result.stdout;
  } catch (err) {
    // pgrep exits 1 when no matches — probe DID run, just no claude
    // around. Anything else (ENOENT, shell "command not found" 127,
    // Windows) means we couldn't probe at all; report unavailable so the
    // watcher can fall back to JSONL recency rather than treating every
    // session as "no process".
    const code = (err as { code?: number | string } | null)?.code;
    if (code === 1) return { counts: new Map(), available: true };
    return { counts: new Map(), available: false };
  }

  const pids = pidsOut
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /^\d+$/.test(s));

  if (pids.length === 0) return { counts: new Map(), available: true };

  const counts = new Map<string, number>();
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const { stdout } = await execP(
          `lsof -p ${pid} -a -d cwd -F n`,
          { timeout: 2000 },
        );
        // lsof -F n format: lines starting with 'n' have the path.
        for (const line of stdout.split("\n")) {
          if (line.startsWith("n/")) {
            const cwd = line.slice(1);
            counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
          }
        }
      } catch {
        // Process exited between pgrep and lsof; ignore.
      }
    }),
  );
  return { counts, available: true };
}
