// Locate the `claude` CLI binary and build its launch args.
//
// We don't ship Claude Code as a dependency — users install it themselves
// (`npm install -g @anthropic-ai/claude-code`, or via the official macOS
// installer at `~/.claude/local/claude`). The route surfaces a clean
// `binary_not_found` to the UI when none of the candidates resolve.

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter as PATH_DELIM, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type ResolveResult =
  | { ok: true; path: string }
  | { ok: false; error: "binary_not_found" };

export function resolveClaudeBinary(packageRoot: string): ResolveResult {
  const isWin = process.platform === "win32";
  const names = isWin ? ["claude.cmd", "claude.ps1", "claude"] : ["claude"];

  // 1. Explicit escape hatch.
  const explicit = process.env.OYSTER_CLAUDE_BIN;
  if (explicit && existsSync(explicit)) {
    return { ok: true, path: explicit };
  }

  const candidates: string[] = [];

  // 2. node_modules/.bin walks (claude bundled as a server dep, or hoisted).
  candidates.push(join(packageRoot, "server", "node_modules", ".bin"));
  candidates.push(join(packageRoot, "node_modules", ".bin"));
  let dir = packageRoot;
  for (let i = 0; i < 5; i++) {
    candidates.push(join(dir, "node_modules", ".bin"));
    dir = dirname(dir);
  }

  // 3. Common official install locations.
  const home = homedir();
  candidates.push(join(home, ".claude", "local"));
  candidates.push(join(home, ".npm-global", "bin"));

  for (const root of candidates) {
    for (const name of names) {
      const candidate = join(root, name);
      if (existsSync(candidate)) return { ok: true, path: candidate };
    }
  }

  // 4. Walk $PATH ourselves. Earlier versions shelled out to `which`/`where`
  //    via `execFileSync` with a 2s timeout — a synchronous subprocess
  //    blocks the Node event loop for every other in-flight request, and
  //    on slow / NFS-backed PATHs it could stall the server for the full
  //    timeout. A pure-fs walk is faster, predictable, and (because each
  //    `statSync` is cheap) tolerates a long PATH without trouble.
  const pathEnv = process.env.PATH ?? "";
  if (pathEnv) {
    for (const dirEntry of pathEnv.split(PATH_DELIM)) {
      if (!dirEntry) continue;
      for (const name of names) {
        const candidate = join(dirEntry, name);
        // statSync absorbs ENOENT cheaply via try/catch; checking isFile()
        // skips matching directories or sockets named `claude`.
        try {
          if (statSync(candidate).isFile()) return { ok: true, path: candidate };
        } catch { /* not here */ }
      }
    }
  }

  return { ok: false, error: "binary_not_found" };
}

export interface LaunchArgs {
  args: string[];
  /** For claude_new: a freshly generated UUID. For claude_resume: the
   *  sessionId passed in. Either way: the canonical session id for the
   *  spawned process, so the caller can pre-insert a session row and
   *  link the PTY synchronously without waiting on the JSONL watcher. */
  sessionId: string;
}

export function buildLaunchArgs(
  kind: "claude_new" | "claude_resume",
  sessionId?: string,
): LaunchArgs {
  if (kind === "claude_resume") {
    if (!sessionId) throw new Error("buildLaunchArgs: claude_resume requires sessionId");
    return { args: ["--resume", sessionId], sessionId };
  }
  // claude_new: generate a UUID and pass it via --session-id so the
  // server knows the session id BEFORE the process writes its first
  // JSONL. Closes the auto-link race that was leaving fresh spawns
  // orphaned (PTY alive, no session row pointing at it).
  const id = randomUUID();
  return { args: ["--session-id", id], sessionId: id };
}
