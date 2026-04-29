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
// an empty set, and the watcher falls back to JSONL-recency-only state
// derivation. Tracked separately — see issue #268.
export async function activeClaudeCwds(): Promise<Set<string>> {
  let pidsOut: string;
  try {
    const result = await execP("pgrep -x claude", { timeout: 2000 });
    pidsOut = result.stdout;
  } catch {
    // pgrep returns exit 1 when no matches; also covers Windows / missing
    // pgrep. Empty set is the right answer in all those cases.
    return new Set();
  }

  const pids = pidsOut
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /^\d+$/.test(s));

  if (pids.length === 0) return new Set();

  const cwds = new Set<string>();
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const { stdout } = await execP(
          `lsof -p ${pid} -a -d cwd -F n`,
          { timeout: 2000 },
        );
        // lsof -F n format: lines starting with 'n' have the path.
        for (const line of stdout.split("\n")) {
          if (line.startsWith("n/")) cwds.add(line.slice(1));
        }
      } catch {
        // Process exited between pgrep and lsof; ignore.
      }
    }),
  );
  return cwds;
}
