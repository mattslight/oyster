// Locate the `claude` CLI binary and build its launch args.
//
// We don't ship Claude Code as a dependency — users install it themselves
// (`npm install -g @anthropic-ai/claude-code`, or via the official macOS
// installer at `~/.claude/local/claude`). The route surfaces a clean
// `binary_not_found` to the UI when none of the candidates resolve.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

  // 4. PATH lookup.
  try {
    const which = isWin ? "where" : "which";
    const out = execFileSync(which, ["claude"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 2000,
    });
    const firstLine = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
    if (firstLine && existsSync(firstLine)) return { ok: true, path: firstLine };
  } catch {
    /* not on PATH */
  }

  return { ok: false, error: "binary_not_found" };
}

export function buildLaunchArgs(
  kind: "claude_new" | "claude_resume",
  sessionId?: string,
): string[] {
  if (kind === "claude_resume") {
    if (!sessionId) throw new Error("buildLaunchArgs: claude_resume requires sessionId");
    return ["--resume", sessionId];
  }
  return [];
}
