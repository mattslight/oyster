// /api/terminals/* — spawn and manage in-app Claude Code PTY terminals.
//
// Cwd is never accepted from the client. The body carries a typed `source`
// reference (project / session / remote_session); the server resolves the
// cwd via `resolveSourceCwd` against trusted DB rows. That makes the route
// safe to call from web origins without arbitrary local-directory exposure.

import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import type { RouteCtx } from "../http-utils.js";
import type { SessionStore } from "../session-store.js";
import type { ProjectService } from "../project-service.js";
import type { ClaudeCodeWatcher } from "../watchers/claude-code.js";
import { pickJsonlCwd } from "../watchers/claude-code.js";
import { encodeCwd } from "../session-sync-service.js";
import { ClaudePtyManager, TerminalCapError, PtyUnavailableError } from "../claude-pty-manager.js";
import { resolveClaudeBinary, buildLaunchArgs } from "../terminal-launcher.js";
import type { UiCommand } from "../../../shared/types.js";

type LaunchKind = "claude_new" | "claude_resume";
type LaunchSource =
  | { type: "project"; id: string }
  | { type: "session"; id: string }
  | { type: "remote_session"; id: string };

export interface TerminalRouteDeps {
  db: Database.Database;
  sessionStore: SessionStore;
  projectService: ProjectService;
  claudeCodeWatcher: ClaudeCodeWatcher;
  claudePtyManager: ClaudePtyManager;
  packageRoot: string;
  /** Clean env (PATH, HOME, etc.) for spawned PTYs. Lifted from index.ts so
   *  the legacy and new launches share scrubbing. */
  cleanEnv: Record<string, string>;
  currentUserId: () => string | null;
  broadcastUiEvent: (event: UiCommand) => void;
}

type ResolveOk = { cwd: string; displayName: string };
type ResolveErr =
  | { error: "project_not_found" }
  | { error: "project_homeless" }
  | { error: "session_not_found" }
  | { error: "session_no_cwd" }
  | { error: "session_cwd_missing" }
  | { error: "session_not_reassembled_yet" }
  | { error: "cwd_not_on_this_device" };

export function resolveSourceCwd(
  source: LaunchSource,
  deps: Pick<TerminalRouteDeps, "db" | "sessionStore" | "projectService" | "currentUserId">,
): ResolveOk | ResolveErr {
  if (source.type === "project") {
    const project = deps.projectService.getById(source.id);
    if (!project) return { error: "project_not_found" };
    if (!project.recentPath || project.hasLivePath === false) {
      return { error: "project_homeless" };
    }
    if (!existsSync(project.recentPath)) return { error: "project_homeless" };
    return { cwd: project.recentPath, displayName: project.name };
  }

  if (source.type === "session") {
    const row = deps.sessionStore.getById(source.id);
    if (!row) return { error: "session_not_found" };
    if (!row.cwd) return { error: "session_no_cwd" };
    if (!existsSync(row.cwd)) return { error: "session_cwd_missing" };
    return { cwd: row.cwd, displayName: row.title ?? basename(row.cwd) };
  }

  // remote_session — bytes already reassembled to disk by /api/sessions/:id/resume.
  const ownerId = deps.currentUserId();
  if (!ownerId) return { error: "session_not_reassembled_yet" };
  const row = deps.db
    .prepare(
      `SELECT jsonl_local_path FROM remote_sessions
        WHERE owner_id = ? AND session_id = ? LIMIT 1`,
    )
    .get(ownerId, source.id) as { jsonl_local_path: string | null } | undefined;
  if (!row || !row.jsonl_local_path) return { error: "session_not_reassembled_yet" };
  if (!existsSync(row.jsonl_local_path)) return { error: "session_not_reassembled_yet" };

  // The parent dir's basename is `encodeCwd(originalCwd)`. The original cwd
  // may not exist on this device (cross-device reassemble), so scan the head
  // events for a `cwd` whose encoding matches the parent dir AND exists
  // locally. Mirrors `pickJsonlCwd` used by the watcher.
  const candidates = headEventCwds(row.jsonl_local_path);
  const resolved = pickJsonlCwd(row.jsonl_local_path, candidates);
  if (!resolved || !existsSync(resolved)) return { error: "cwd_not_on_this_device" };
  return { cwd: resolved, displayName: basename(resolved) };
}

/** Read a few KB from the head of a jsonl and collect any `cwd` fields seen.
 *  Mirrors the head-scan in `ClaudeCodeWatcher.readSessionMetadata`, scoped
 *  small. Used only for remote-session resume. */
function headEventCwds(jsonlPath: string): string[] {
  const HEAD_BYTES = 65_536;
  const buf = Buffer.alloc(HEAD_BYTES);
  let fd: number | null = null;
  try {
    fd = openSync(jsonlPath, "r");
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    const text = buf.slice(0, n).toString("utf8");
    const cwds: string[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (typeof ev?.cwd === "string") cwds.push(ev.cwd);
      } catch { /* skip malformed */ }
    }
    return cwds;
  } catch {
    return [];
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* ignore */ }
  }
}

export async function tryHandleTerminalRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: RouteCtx,
  deps: TerminalRouteDeps,
): Promise<boolean> {
  const { sendJson, sendError, readJsonBody, rejectIfNonLocalOrigin } = ctx;

  if (url === "/api/terminals" && req.method === "GET") {
    if (rejectIfNonLocalOrigin()) return true;
    sendJson(deps.claudePtyManager.list());
    return true;
  }

  if (url === "/api/terminals" && req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return true;
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody();
    } catch (err) {
      sendError(err);
      return true;
    }
    if ("cwd" in body) {
      sendJson({ error: "cwd_not_accepted", message: "Provide a typed `source` reference, not a cwd." }, 400);
      return true;
    }
    const kind = body.kind as LaunchKind | undefined;
    if (kind !== "claude_new" && kind !== "claude_resume") {
      sendJson({ error: "invalid_kind" }, 400);
      return true;
    }
    const source = body.source as LaunchSource | undefined;
    if (!source || typeof source !== "object" || typeof source.id !== "string" || source.id.length === 0) {
      sendJson({ error: "invalid_source" }, 400);
      return true;
    }
    if (source.type !== "project" && source.type !== "session" && source.type !== "remote_session") {
      sendJson({ error: "invalid_source_type" }, 400);
      return true;
    }
    if (kind === "claude_resume" && source.type === "project") {
      sendJson({ error: "resume_requires_session_source" }, 400);
      return true;
    }
    if (kind === "claude_new" && source.type === "remote_session") {
      // We could allow this in future (start a fresh claude in the
      // reassembled cwd); for v1 keep the surface tight.
      sendJson({ error: "new_session_requires_project_or_session_source" }, 400);
      return true;
    }

    const resolved = resolveSourceCwd(source, deps);
    if ("error" in resolved) {
      sendJson({ error: resolved.error }, 400);
      return true;
    }
    if (!statSync(resolved.cwd).isDirectory()) {
      sendJson({ error: "cwd_not_a_directory" }, 400);
      return true;
    }

    const bin = resolveClaudeBinary(deps.packageRoot);
    if (!bin.ok) {
      sendJson(
        {
          error: "binary_not_found",
          installHint: "npm install -g @anthropic-ai/claude-code",
        },
        400,
      );
      return true;
    }

    // Capture BEFORE spawn so any JSONL claude writes during init is inside
    // the auto-link window. The watcher's `onceNewJsonl` allows a 1s back-
    // window on top of this for mtime resolution slop.
    const sinceMs = Date.now();
    const args = buildLaunchArgs(kind, source.type === "session" || source.type === "remote_session" ? source.id : undefined);

    let spawned: { terminalId: string; startedAt: number };
    try {
      spawned = deps.claudePtyManager.spawn({
        kind,
        command: bin.path,
        args,
        cwd: resolved.cwd,
        env: deps.cleanEnv,
      });
    } catch (err) {
      if (err instanceof TerminalCapError) {
        sendJson({ error: "too_many_terminals" }, 429);
        return true;
      }
      if (err instanceof PtyUnavailableError) {
        sendJson({ error: "pty_unavailable" }, 503);
        return true;
      }
      sendError(err, 500);
      return true;
    }

    const { terminalId, startedAt } = spawned;

    // Auto-link is fire-and-forget. claude_resume: we already know the id —
    // attach it synchronously and broadcast. claude_new: watch for the next
    // JSONL in the encoded-cwd dir.
    if (kind === "claude_resume" && source.type === "session") {
      deps.claudePtyManager.setLinkedSession(terminalId, source.id);
      deps.broadcastUiEvent({
        version: 1,
        command: "terminal_session_linked",
        payload: { terminalId, sessionId: source.id },
      });
    } else if (kind === "claude_new") {
      const encoded = encodeCwd(resolved.cwd);
      deps.claudeCodeWatcher
        .onceNewJsonl(encoded, sinceMs)
        .then((result) => {
          if (!result) return;
          const entry = deps.claudePtyManager.getEntry(terminalId);
          if (!entry || entry.exitedAt !== null) return;
          deps.claudePtyManager.setLinkedSession(terminalId, result.sessionId);
          deps.broadcastUiEvent({
            version: 1,
            command: "terminal_session_linked",
            payload: { terminalId, sessionId: result.sessionId },
          });
        })
        .catch(() => { /* best-effort */ });
    }

    sendJson({
      terminalId,
      kind,
      cwd: resolved.cwd,
      displayName: resolved.displayName,
      command: bin.path,
      args,
      startedAt,
    });
    return true;
  }

  const deleteMatch = url.match(/^\/api\/terminals\/([^/?#]+)$/);
  if (deleteMatch && req.method === "DELETE") {
    if (rejectIfNonLocalOrigin()) return true;
    const id = deleteMatch[1]!;
    deps.claudePtyManager.kill(id);
    res.writeHead(204);
    res.end();
    return true;
  }

  return false;
}

// Re-exported for routes/index.ts callers that want to check existence
// without parsing the response object.
export { dirname as _dirnameForTests };
