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
// Cross-platform note: pgrep + lsof are POSIX-only. On Windows this returns
// an empty map, and the watcher falls back to JSONL-recency-only state
// derivation. Tracked separately — see issue #268.
//
// Returns a count per cwd (not a set) because two claude processes can be
// running at the same cwd — worktrees, pair-programming workflows, parallel
// investigations. Counts let the heartbeat pick the top-K most-recently-
// streamed sessions per cwd as live, instead of either marking only one
// (false negative) or marking every past transcript at that cwd (false
// positive).
export async function activeClaudeCwdCounts(): Promise<Map<string, number>> {
  let pidsOut: string;
  try {
    const result = await execP("pgrep -x claude", { timeout: 2000 });
    pidsOut = result.stdout;
  } catch {
    // pgrep returns exit 1 when no matches; also covers Windows / missing
    // pgrep. Empty map is the right answer in all those cases.
    return new Map();
  }

  const pids = pidsOut
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /^\d+$/.test(s));

  if (pids.length === 0) return new Map();

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
  return counts;
}
