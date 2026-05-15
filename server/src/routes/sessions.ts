// /api/sessions/* route bucket — extracted from index.ts.
//
// Returns true when a request was handled; the caller (index.ts) keeps
// dispatching to other route modules / inline handlers when this returns
// false. Same semantics as the if-block sequence it replaces — no
// behavioural changes, only refactored shape.

import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import type { SessionStore } from "../session-store.js";
import type { SqliteSpaceStore } from "../space-store.js";
import type { ArtifactService } from "../artifact-service.js";
import type { MemoryProvider } from "../memory-store.js";
import type { RouteCtx } from "../http-utils.js";
import { SessionService, SessionNotFoundError, SourceNotFoundError, InvalidMoveSessionInputError } from "../session-service.js";
import type { UiCommand } from "../../../shared/types.js";
import {
  encodeCwd,
  LocalDivergedError,
  projectsRoot,
  type SessionSyncService,
} from "../session-sync-service.js";

export interface SessionRouteDeps {
  db: Database.Database;
  sessionStore: SessionStore;
  spaceStore: SqliteSpaceStore;
  artifactService: ArtifactService;
  memoryProvider: MemoryProvider;
  sessionSync: SessionSyncService;
  /** Caller for the current Pro user (for resume gating + path queries). */
  currentUserId: () => string | null;
  sessionService: SessionService;
  broadcastUiEvent: (event: UiCommand) => void;
}

// ── Resume helpers (#322 PR 2) ──────────────────────────────────────────

interface SourceCandidate {
  path: string;
  label: string | null;
}

/** Find which local folder(s) match a remote session's space_id. Returns
 *  exactly one when there's an unambiguous mapping, an empty array when
 *  this device hasn't attached any source to that space (needs_target),
 *  or N candidates when multiple sources exist for the space (pick_source). */
function findResumeCandidates(
  db: Database.Database,
  spaceStore: SqliteSpaceStore,
  sessionId: string,
  ownerId: string,
): { spaceId: string | null; candidates: SourceCandidate[]; remoteCwd: string | null } {
  // Look up the remote session's space_id by joining to the local sessions
  // table first (if we happen to have ingested it locally too), else fall
  // back to nothing — remote sessions don't carry space_id today; their
  // cwd is the only locator we have. We use that to find a matching source
  // by path-prefix as a best-effort.
  const remote = db.prepare(
    `SELECT cwd FROM remote_sessions WHERE owner_id = ? AND session_id = ? LIMIT 1`,
  ).get(ownerId, sessionId) as { cwd: string | null } | undefined;
  const remoteCwd = remote?.cwd ?? null;

  // Approach: scan all active local sources. A source is a candidate when
  // either: (a) its path is a prefix of the remote cwd (the remote session
  // lived inside a project the user has attached locally — even if at a
  // different on-disk path), or (b) the basename of its path matches the
  // basename of the remote cwd (rough but useful for "same project, sister
  // worktrees" cases). Both checks are advisory — the picker is the
  // safety net for anything we don't auto-resolve.
  if (!remoteCwd) {
    return { spaceId: null, candidates: [], remoteCwd: null };
  }
  const remoteBasename = basename(remoteCwd);
  const allSources = db.prepare(
    `SELECT id, space_id, path, label FROM sources WHERE removed_at IS NULL`,
  ).all() as Array<{ id: string; space_id: string; path: string; label: string | null }>;
  const candidates: SourceCandidate[] = [];
  for (const src of allSources) {
    const matchesPrefix = remoteCwd === src.path || remoteCwd.startsWith(`${src.path}/`);
    const matchesBasename = basename(src.path) === remoteBasename;
    if (matchesPrefix || matchesBasename) {
      candidates.push({ path: src.path, label: src.label ?? basename(src.path) });
    }
  }
  // Dedupe by path (sources can legitimately share a basename + prefix overlap).
  const seen = new Set<string>();
  const deduped = candidates.filter((c) => seen.has(c.path) ? false : (seen.add(c.path), true));
  void spaceStore;  // currently unused; reserved for future space-based heuristics
  return { spaceId: null, candidates: deduped, remoteCwd };
}

interface ValidationOutcome {
  ok: boolean;
  reasons: string[];
}

/** Validate a user-supplied targetCwd before reassembling into it.
 *  Hard fail (returns ok:false) only on folder-doesn't-exist. Other
 *  conditions are advisory and surfaced as reasons so the UI can
 *  prompt for force:true confirmation. */
/** Read the local device identity row (seeded at boot). Returns NULLs when
 *  the row isn't present — callers degrade gracefully (no active chip). */
function readMyDeviceIdentity(db: Database.Database): {
  myDeviceId: string | null;
  myDeviceLabel: string | null;
} {
  const row = db.prepare(
    `SELECT device_id, label FROM device_identity WHERE id = 1 LIMIT 1`,
  ).get() as { device_id: string; label: string } | undefined;
  return {
    myDeviceId: row?.device_id ?? null,
    myDeviceLabel: row?.label ?? null,
  };
}

/** Resolves `activeDeviceLabel` for a session row given this device's
 *  identity. Two known sources for a label: device_identity (when active is
 *  us) and remote_sessions.device_label (when active is the origin device).
 *  Anything else — a third device we haven't seen yet — falls back to null
 *  rather than guessing. Used by both the merge route and the singular GET. */
function makeActiveLabelResolver(
  myDeviceId: string | null,
  myDeviceLabel: string | null,
): (activeId: string | null, originId: string | null, originLabel: string | null) => string | null {
  return (activeId, originId, originLabel) => {
    if (!activeId) return null;
    if (myDeviceId && activeId === myDeviceId) return myDeviceLabel;
    if (originId && activeId === originId) return originLabel;
    return null;
  };
}

function validateOverrideTarget(targetCwd: string, remoteCwd: string | null): ValidationOutcome {
  const reasons: string[] = [];
  if (!existsSync(targetCwd)) {
    return { ok: false, reasons: ["target_folder_missing"] };
  }
  const st = statSync(targetCwd);
  if (!st.isDirectory()) {
    return { ok: false, reasons: ["target_not_a_directory"] };
  }
  if (!existsSync(join(targetCwd, ".git"))) {
    reasons.push("not_a_git_repo");
  }
  if (remoteCwd) {
    if (basename(targetCwd).toLowerCase() !== basename(remoteCwd).toLowerCase()) {
      reasons.push("repo_basename_differs");
    }
    // If the target is a git repo AND the session's original cwd was a git
    // repo, prefer to match remotes. We can only check the LOCAL remote; we
    // don't store the original. Best we can do is check there IS a remote.
    if (existsSync(join(targetCwd, ".git"))) {
      try {
        execFileSync("git", ["-C", targetCwd, "remote", "get-url", "origin"], {
          stdio: ["ignore", "pipe", "ignore"],
          encoding: "utf8",
        });
        // origin exists — assume the user knows what they're doing.
      } catch {
        reasons.push("no_git_remote_origin");
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export async function tryHandleSessionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: RouteCtx,
  deps: SessionRouteDeps,
): Promise<boolean> {
  const { sendJson, sendError, rejectIfNonLocalOrigin, readJsonBody } = ctx;
  const { db, sessionStore, spaceStore, artifactService, memoryProvider, sessionSync, currentUserId, sessionService, broadcastUiEvent } = deps;

  // GET /api/sessions — agent sessions captured by the watchers (#251).
  // Read-only for 0.5.0; the home feed renders these. Local-origin only —
  // session titles are derived from user prompts, which are private.
  if (url === "/api/sessions" && req.method === "GET") {
    if (rejectIfNonLocalOrigin()) return true;
    const rows = sessionStore.getAll();
    // Join sources for sourceLabel — batched IN-list queries so the
    // home feed can show "active project" tiles without a per-tile
    // round trip. Sources are dedup'd because most sessions cluster
    // around a small number of registered folders. Chunked at 500
    // ids per batch to stay well below SQLite's 999-bound-variable
    // ceiling on installs that haven't been recompiled with the
    // higher 32_766 limit.
    const sourceIds = [...new Set(rows.map((r) => r.source_id).filter((id): id is string => !!id))];
    const SOURCE_BATCH = 500;
    const sourceList = [];
    for (let i = 0; i < sourceIds.length; i += SOURCE_BATCH) {
      sourceList.push(...spaceStore.getSourcesByIds(sourceIds.slice(i, i + SOURCE_BATCH)));
    }
    interface MergedSessionPayload {
      id: string;
      spaceId: string | null;
      sourceId: string | null;
      sourceLabel: string | null;
      projectId: string | null;
      cwd: string | null;
      agent: string;
      title: string | null;
      state: string;
      startedAt: string;
      endedAt: string | null;
      model: string | null;
      lastEventAt: string;
      originDeviceId: string | null;
      originDeviceLabel: string | null;
      jsonlAvailableLocally: boolean;
      hasBytes: boolean;
      activeDeviceId: string | null;
      /** Human-readable label of whichever device most recently wrote a
       *  chunk for this session. Resolved server-side from one of:
       *  - this device's device_identity.label (when active is us)
       *  - remote_sessions.device_label (when active is the origin device)
       *  - null (when active is some third device we don't yet know about).
       *  Drives the "Now active on Mac" chip in the UI. */
      activeDeviceLabel: string | null;
      assignmentMode?: "auto" | "manual";
    }
    // Cache the current device identity once — used to resolve "active is us"
    // for both local and remote payload entries. NULL when device_identity
    // hasn't been seeded yet; the chip silently skips in that case.
    const { myDeviceId, myDeviceLabel } = readMyDeviceIdentity(db);
    const resolveActiveLabel = makeActiveLabelResolver(myDeviceId, myDeviceLabel);
    const sourcesById = new Map(sourceList.map((s) => [s.id, s]));
    const localPayload: MergedSessionPayload[] = rows.map((row) => {
      const src = row.source_id ? sourcesById.get(row.source_id) : null;
      const label = src ? (src.label ?? (basename(src.path) || null)) : null;
      return {
        id: row.id,
        spaceId: row.space_id,
        sourceId: row.source_id ?? null,
        sourceLabel: label,
        projectId: row.project_id ?? null,
        cwd: row.cwd,
        agent: row.agent,
        title: row.title,
        state: row.state,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        model: row.model,
        lastEventAt: row.last_event_at,
        // Local sessions are by definition available on this device.
        originDeviceId: null,
        originDeviceLabel: null,
        jsonlAvailableLocally: true,
        // We don't track "is there a cloud chunk for this local session" here
        // — that requires a cloud round-trip. For the UI, the
        // jsonlAvailableLocally flag is the right gate. hasBytes mirrors that
        // (the file is on disk, so there are bytes to read).
        hasBytes: true,
        // Local sessions are always actively written by this device.
        activeDeviceId: null,
        activeDeviceLabel: null,
        assignmentMode: row.assignment_mode,
      };
    });

    // Merge cross-device sessions from remote_sessions. Pulled by
    // SessionSyncService from the cloud's GET /api/sessions/metadata.
    // We exclude any remote rows whose session_id already exists locally
    // (the watcher's source of truth for things this device produced).
    const ownerId = currentUserId();
    let remotePayload: MergedSessionPayload[] = [];
    if (ownerId) {
      const localIds = new Set(rows.map((r) => r.id));
      type RemoteRow = {
        session_id: string; device_id: string | null; device_label: string | null;
        agent: string; title: string | null;
        state: string; cwd: string | null; model: string | null; started_at: string;
        ended_at: string | null; last_event_at: string; has_bytes: number;
        total_bytes: number | null;
        active_device_id: string | null; jsonl_local_path: string | null;
      };
      const remoteRows = db.prepare(
        `SELECT session_id, device_id, device_label, agent, title, state, cwd, model,
                started_at, ended_at, last_event_at, has_bytes, total_bytes,
                active_device_id, jsonl_local_path
           FROM remote_sessions
          WHERE owner_id = ?
          ORDER BY last_event_at DESC`,
      ).all(ownerId) as RemoteRow[];
      // Ghost-session filter (PR 3.2a temporary heuristic): hide remote
      // sessions that look like aborted `claude` invocations — title NULL,
      // never properly ended, and the chunk chain is smaller than the
      // typical "permission-mode + file-history + a couple of
      // <command-name>/exit</command-name> events" overhead (~2 KB observed,
      // 4 KB cap for headroom). Rows whose total_bytes is NULL (pre-3.2a
      // pulls, or rows pushed before the column existed) are exempt — we'd
      // rather keep them visible than risk hiding real sessions until the
      // next pull populates the column.
      //
      // Durable fix [[durable-fix-deferred-to-3.2.x]]: add
      // real_user_message_count + assistant_message_count to metadata and
      // filter where both are 0. Tracks content, not size.
      const GHOST_BYTE_THRESHOLD = 4096;
      const isGhostSession = (r: RemoteRow): boolean =>
        r.title === null
        && r.ended_at === null
        && r.total_bytes !== null
        && r.total_bytes < GHOST_BYTE_THRESHOLD;
      remotePayload = remoteRows
        .filter((r) => !localIds.has(r.session_id))
        .filter((r) => !isGhostSession(r))
        .map((r) => ({
          id: r.session_id,
          spaceId: null,
          sourceId: null,
          sourceLabel: null,
          projectId: null,
          cwd: r.cwd,
          agent: r.agent,
          title: r.title,
          state: r.state,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          model: r.model,
          lastEventAt: r.last_event_at,
          originDeviceId: r.device_id,
          originDeviceLabel: r.device_label,
          // Available locally only if the user has already reassembled it.
          jsonlAvailableLocally: r.jsonl_local_path !== null,
          hasBytes: r.has_bytes === 1,
          activeDeviceId: r.active_device_id,
          activeDeviceLabel: resolveActiveLabel(r.active_device_id, r.device_id, r.device_label),
        }));
    }

    // Combine; sort by lastEventAt DESC to keep the list cohesive.
    const merged = [...localPayload, ...remotePayload].sort((a, b) =>
      (b.lastEventAt ?? "").localeCompare(a.lastEventAt ?? ""),
    );
    sendJson(merged);
    return true;
  }

  // GET /api/sessions/search?q=…&session_id=…&limit=…
  // R2 verbatim recall (#311). FTS5 over session_events.text. Mirrors the
  // MCP `recall_transcripts` tool surface for the web UI.
  // Local-origin only — transcripts are private user content.
  {
    const searchPath = url.split("?")[0];
    if (searchPath === "/api/sessions/search" && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return true;
      const parsed = new URL(req.url ?? "/", "http://localhost");
      const q = parsed.searchParams.get("q") ?? "";
      const scopeSession = parsed.searchParams.get("session_id") ?? undefined;
      const limitRaw = parsed.searchParams.get("limit");
      // Validate before clamping — Number("foo") is NaN, which Math.min/max
      // propagate. Treat anything non-finite or non-positive as "use the
      // store's default" rather than 400'ing.
      let limit: number | undefined;
      if (limitRaw !== null) {
        const parsedLimit = Number(limitRaw);
        if (Number.isFinite(parsedLimit) && parsedLimit >= 1) {
          limit = Math.min(50, Math.floor(parsedLimit));
        }
      }
      try {
        const hits = sessionStore.searchEvents(q, { sessionId: scopeSession, limit });
        // Rename `id` → `event_id` for the wire format (the web UI's
        // ambient `id` is artefact id; explicit naming avoids confusion).
        sendJson(hits.map((h) => ({
          event_id: h.id,
          session_id: h.session_id,
          session_title: h.session_title,
          role: h.role,
          ts: h.ts,
          snippet: h.snippet,
        })));
      } catch (err) {
        sendError(err, 500);
      }
      return true;
    }
  }

  // GET /api/sessions/:id — single session row (or 404). Checks the local
  // sessions table first; falls back to remote_sessions so clicking a
  // cross-device row from Home opens its inspector with the same shape
  // (plus originDeviceId/Label/hasBytes for the Resume affordance).
  // Without the fallback every remote click returns 404 → "session no
  // longer available", which is wrong: the row IS in our DB, just in the
  // remote_sessions table.
  {
    const m = url.match(/^\/api\/sessions\/([^/]+)$/);
    if (m && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return true;
      const id = m[1]!;
      const row = sessionStore.getById(id);
      if (row) {
        const src = row.source_id ? spaceStore.getSourceById(row.source_id) : undefined;
        const sourceLabel = src ? (src.label ?? (basename(src.path) || null)) : null;
        sendJson({
          id: row.id,
          spaceId: row.space_id,
          sourceId: row.source_id ?? null,
          sourceLabel,
          projectId: row.project_id ?? null,
          cwd: row.cwd,
          agent: row.agent,
          title: row.title,
          state: row.state,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          model: row.model,
          lastEventAt: row.last_event_at,
          // Local sessions are by definition local — null/true.
          originDeviceId: null,
          originDeviceLabel: null,
          jsonlAvailableLocally: true,
          hasBytes: true,
          activeDeviceId: null,
          activeDeviceLabel: null,
          assignmentMode: row.assignment_mode,
        });
        return true;
      }

      const ownerId = currentUserId();
      if (ownerId) {
        type RemoteRow = {
          device_id: string | null; device_label: string | null;
          agent: string; title: string | null; state: string;
          cwd: string | null; model: string | null; started_at: string;
          ended_at: string | null; last_event_at: string;
          has_bytes: number; active_device_id: string | null;
          jsonl_local_path: string | null;
        };
        const remoteRow = db.prepare(
          `SELECT device_id, device_label, agent, title, state, cwd, model,
                  started_at, ended_at, last_event_at, has_bytes,
                  active_device_id, jsonl_local_path
             FROM remote_sessions
            WHERE owner_id = ? AND session_id = ? LIMIT 1`,
        ).get(ownerId, id) as RemoteRow | undefined;
        if (remoteRow) {
          const { myDeviceId, myDeviceLabel } = readMyDeviceIdentity(db);
          const resolve = makeActiveLabelResolver(myDeviceId, myDeviceLabel);
          sendJson({
            id,
            spaceId: null,
            sourceId: null,
            sourceLabel: null,
            projectId: null,
            cwd: remoteRow.cwd,
            agent: remoteRow.agent,
            title: remoteRow.title,
            state: remoteRow.state,
            startedAt: remoteRow.started_at,
            endedAt: remoteRow.ended_at,
            model: remoteRow.model,
            lastEventAt: remoteRow.last_event_at,
            originDeviceId: remoteRow.device_id,
            originDeviceLabel: remoteRow.device_label,
            jsonlAvailableLocally: remoteRow.jsonl_local_path !== null,
            hasBytes: remoteRow.has_bytes === 1,
            activeDeviceId: remoteRow.active_device_id,
            activeDeviceLabel: resolve(
              remoteRow.active_device_id, remoteRow.device_id, remoteRow.device_label,
            ),
          });
          return true;
        }
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "session not found" }));
      return true;
    }
  }

  // PATCH /api/sessions/:id — reassign a session to a different source or
  // back to auto-binding. The whole "cwd is evidence, not authority" model
  // lives here: setting source_id flips the row to manual; setting
  // assignment_mode: 'auto' triggers an atomic recompute via longest-prefix
  // lookup on the row's cwd.
  {
    const m = url.match(/^\/api\/sessions\/([^/]+)$/);
    if (m && req.method === "PATCH") {
      if (rejectIfNonLocalOrigin()) return true;
      const id = m[1]!;
      try {
        const body = await readJsonBody();
        const input: { session_id: string; source_id?: string | null; space_id?: string; assignment_mode?: "auto" | "manual" } = { session_id: id };
        if ("source_id" in body) {
          if (body.source_id === null) {
            input.source_id = null;
          } else if (typeof body.source_id === "string" && body.source_id.trim().length > 0) {
            input.source_id = body.source_id.trim();
          } else {
            sendJson({ error: "source_id must be a non-empty string or null" }, 400);
            return true;
          }
        }
        if ("space_id" in body) {
          // Empty / whitespace-only space_id would hit the sessions FK
          // constraint as a constraint error and bubble out as a 500;
          // catch it here as a clean 400. The service still validates
          // existence — passing a non-empty-but-unknown id surfaces as a
          // service-level error.
          if (typeof body.space_id === "string" && body.space_id.trim().length > 0) {
            input.space_id = body.space_id.trim();
          } else {
            sendJson({ error: "space_id must be a non-empty string" }, 400);
            return true;
          }
        }
        if (body.assignment_mode === "auto" || body.assignment_mode === "manual") {
          input.assignment_mode = body.assignment_mode;
        } else if (body.assignment_mode !== undefined) {
          sendJson({ error: "assignment_mode must be 'auto' or 'manual'" }, 400);
          return true;
        }
        const updated = sessionService.moveSession(input);
        const src = updated.source_id ? spaceStore.getSourceById(updated.source_id) : undefined;
        const sourceLabel = src ? (src.label ?? (basename(src.path) || null)) : null;
        broadcastUiEvent({ version: 1, command: "session_changed", payload: { id } });
        sendJson({
          id: updated.id,
          spaceId: updated.space_id,
          sourceId: updated.source_id ?? null,
          sourceLabel,
          cwd: updated.cwd,
          agent: updated.agent,
          title: updated.title,
          state: updated.state,
          startedAt: updated.started_at,
          endedAt: updated.ended_at,
          model: updated.model,
          lastEventAt: updated.last_event_at,
          assignmentMode: updated.assignment_mode,
          originDeviceId: null,
          originDeviceLabel: null,
          jsonlAvailableLocally: true,
          hasBytes: true,
          activeDeviceId: null,
          activeDeviceLabel: null,
        });
      } catch (err) {
        if (err instanceof SessionNotFoundError || err instanceof SourceNotFoundError) {
          sendJson({ error: err.message }, 404);
          return true;
        }
        if (err instanceof InvalidMoveSessionInputError) {
          sendJson({ error: err.message }, 400);
          return true;
        }
        sendError(err);
      }
      return true;
    }
  }

  // GET /api/sessions/:id/events — transcript events (oldest first within
  // the returned slice). The `raw` JSONL line is dropped because long
  // sessions can ship 50+MB of raw blobs; clients lazy-fetch raw via
  // /events/:eventId when they expand a tool turn.
  //
  // Cursors:
  //   ?before=<id> — events with id < before, latest N (load older on scroll up)
  //   ?after=<id>  — events with id > after, oldest N (live append)
  //   neither     — latest N (bootstrap)
  // ?limit=N defaults to 1000.
  {
    // Strip the query string before path matching — the `$` anchor in the
    // regex would otherwise reject any URL with `?...`. Pre-existing bug:
    // `?limit=N` was always silently ignored before this fix.
    const eventsPath = url.split("?")[0];
    const m = eventsPath.match(/^\/api\/sessions\/([^/]+)\/events$/);
    if (m && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return true;
      const parsed = new URL(req.url ?? "/", "http://localhost");
      const limitParam = parsed.searchParams.get("limit");
      const limit = limitParam && Number.isFinite(Number(limitParam))
        ? Math.max(1, Math.min(10_000, Number(limitParam)))
        : 1000;
      const beforeParam = parsed.searchParams.get("before");
      const afterParam = parsed.searchParams.get("after");
      const aroundParam = parsed.searchParams.get("around");
      const before = beforeParam && Number.isFinite(Number(beforeParam))
        ? Number(beforeParam) : null;
      const after = afterParam && Number.isFinite(Number(afterParam))
        ? Number(afterParam) : null;
      const around = aroundParam && Number.isFinite(Number(aroundParam))
        ? Number(aroundParam) : null;
      let events;
      if (around !== null) {
        // Centred window: split the budget so the merged result is at
        // most `limit` events. The target is included in the "older"
        // half (id <= around), so olderLimit gets the ceil. Sort ASC
        // by id so the transcript renders chronologically regardless
        // of how the underlying statements ordered their result sets.
        const olderLimit = Math.max(1, Math.ceil(limit / 2));
        const newerLimit = Math.max(0, limit - olderLimit);
        const older = sessionStore.getEventsBeforeBySession(m[1], around + 1, olderLimit);
        const newer = newerLimit > 0
          ? sessionStore.getEventsAfterBySession(m[1], around, newerLimit)
          : [];
        events = [...older, ...newer].sort((a, b) => a.id - b.id);
      } else if (before !== null) {
        events = sessionStore.getEventsBeforeBySession(m[1], before, limit);
      } else if (after !== null) {
        events = sessionStore.getEventsAfterBySession(m[1], after, limit);
      } else {
        events = sessionStore.getEventsBySession(m[1], { limit });
      }
      sendJson(events.map((e) => ({
        id: e.id,
        sessionId: e.session_id,
        role: e.role,
        text: e.text,
        ts: e.ts,
        raw: null as string | null,
      })));
      return true;
    }
  }

  // GET /api/sessions/:id/events/:eventId — single event WITH raw JSONL.
  // Exists so the inspector can lazily load the raw blob for tool-call
  // expand without paying for it on every transcript fetch.
  {
    const m = url.match(/^\/api\/sessions\/([^/]+)\/events\/(\d+)$/);
    if (m && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return true;
      const eventId = Number(m[2]);
      const ev = sessionStore.getEventById(m[1], eventId);
      if (!ev) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "event not found" }));
        return true;
      }
      sendJson({
        id: ev.id,
        sessionId: ev.session_id,
        role: ev.role,
        text: ev.text,
        ts: ev.ts,
        raw: ev.raw,
      });
      return true;
    }
  }

  // GET /api/sessions/:id/artifacts — touched artefacts joined with artifact metadata
  {
    const m = url.match(/^\/api\/sessions\/([^/]+)\/artifacts$/);
    if (m && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return true;
      const touches = sessionStore.getArtifactsBySession(m[1]);
      const uniqueIds = Array.from(new Set(touches.map((t) => t.artifact_id)));
      const artifacts = await artifactService.getArtifactsByIds(uniqueIds);
      const byId = new Map(artifacts.map((a) => [a.id, a]));
      sendJson(touches.flatMap((t) => {
        const a = byId.get(t.artifact_id);
        if (!a) return [];
        return [{
          id: t.id,
          sessionId: t.session_id,
          artifactId: t.artifact_id,
          role: t.role,
          whenAt: t.when_at,
          artifact: a,
        }];
      }));
      return true;
    }
  }

  // GET /api/sessions/:id/memory — memories associated with this session.
  // R6 traceable recall (#310): returns {written, pulled} where written
  // are memories whose source_session_id == :id and pulled are memories
  // this session retrieved via recall(). Each memory has its source
  // session title resolved across the memory↔sessions DB boundary so
  // the UI can render "from <title>" without a second round trip.
  {
    const m = url.match(/^\/api\/sessions\/([^/]+)\/memory$/);
    if (m && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return true;
      try {
        const [written, pulled] = await Promise.all([
          memoryProvider.getBySourceSession(m[1]),
          memoryProvider.getRecalledBySession(m[1]),
        ]);
        // Resolve source_session_title for every memory we're about to
        // return. Batched: collect distinct session ids, fetch titles
        // once, then attach. memory.db and oyster.db are separate, so
        // this stitch happens at the API layer.
        const sourceIds = new Set<string>();
        for (const memory of [...written, ...pulled]) {
          if (memory.source_session_id) sourceIds.add(memory.source_session_id);
        }
        const titleById = new Map<string, string | null>();
        for (const sid of sourceIds) {
          titleById.set(sid, sessionStore.getById(sid)?.title ?? null);
        }
        const enrich = (memory: typeof written[number]) => ({
          ...memory,
          source_session_title: memory.source_session_id
            ? (titleById.get(memory.source_session_id) ?? null)
            : null,
        });
        sendJson({
          written: written.map(enrich),
          pulled: pulled.map(enrich),
        });
      } catch (err) {
        sendError(err, 500);
      }
      return true;
    }
  }

  // POST /api/sessions/:id/resume — pull a cross-device session's encrypted
  // jsonl chunks from cloud, reassemble + verify locally, return the
  // `claude --resume <id>` command for the user to run.
  //
  // Body: { targetCwd?: string, force?: boolean }
  //
  // Without `targetCwd`: auto-resolve via remote_sessions.cwd + local sources.
  //   - 1 unambiguous candidate → use it
  //   - 0 candidates → return { status: "needs_target", remoteCwd }
  //   - N candidates → return { status: "pick_source", candidates: [...] }
  //
  // With `targetCwd`: validate (folder exists, git repo, basename match,
  // remote present). On warnings, return { status: "validation_warning",
  // reasons: [...] } and require force:true to bypass.
  //
  // Local-origin only — placing a jsonl on the user's filesystem.
  {
    const m = url.match(/^\/api\/sessions\/([^/]+)\/resume$/);
    if (m && req.method === "POST") {
      if (rejectIfNonLocalOrigin()) return true;
      const sessionId = m[1]!;
      try {
        const body = await readJsonBody();
        const ownerId = currentUserId();
        if (!ownerId) {
          sendJson({ error: "sign_in_required" }, 401);
          return true;
        }

        // 1. The session must be in remote_sessions and have bytes uploaded.
        type RemoteRow = { cwd: string | null; has_bytes: number };
        const remoteRow = db.prepare(
          `SELECT cwd, has_bytes FROM remote_sessions WHERE owner_id = ? AND session_id = ? LIMIT 1`,
        ).get(ownerId, sessionId) as RemoteRow | undefined;
        if (!remoteRow) {
          sendJson({ error: "session_not_found_in_remote" }, 404);
          return true;
        }
        if (remoteRow.has_bytes !== 1) {
          sendJson({ error: "bytes_not_available", message: "Cloud has metadata for this session but no chunks yet." }, 409);
          return true;
        }

        // 2. Resolve target cwd.
        let targetCwd: string;
        const overrideCwd = typeof body.targetCwd === "string" ? body.targetCwd : null;
        const force = body.force === true;

        if (overrideCwd) {
          // User-supplied target — validate.
          const validation = validateOverrideTarget(overrideCwd, remoteRow.cwd);
          // Only "target_folder_missing" / "target_not_a_directory" are truly
          // fatal — force:true cannot conjure a folder into existence. All
          // other reasons (.git missing, basename differs, no origin remote)
          // are soft and require explicit force:true to bypass.
          const HARD_REASONS = new Set<string>(["target_folder_missing", "target_not_a_directory"]);
          const hardReasons = validation.reasons.filter((r) => HARD_REASONS.has(r));
          const softReasons = validation.reasons.filter((r) => !HARD_REASONS.has(r));
          if (hardReasons.length > 0) {
            sendJson({ status: "validation_warning", reasons: validation.reasons }, 200);
            return true;
          }
          if (softReasons.length > 0 && !force) {
            sendJson({ status: "validation_warning", reasons: validation.reasons }, 200);
            return true;
          }
          targetCwd = overrideCwd;
        } else {
          // No override — try auto-resolve via local sources.
          const { candidates, remoteCwd } = findResumeCandidates(db, spaceStore, sessionId, ownerId);
          if (candidates.length === 0) {
            sendJson({ status: "needs_target", remoteCwd, suggestedSpaceId: null }, 200);
            return true;
          }
          if (candidates.length > 1) {
            sendJson({ status: "pick_source", candidates, remoteCwd }, 200);
            return true;
          }
          targetCwd = candidates[0]!.path;
        }

        // 3. Reassemble chunks into the encoded jsonl path Claude Code expects.
        // Three outcomes from the service:
        //   - success: jsonl is on disk at localJsonlPath (or already was).
        //   - throw LocalDivergedError: this device has unsynced edits past
        //     cloud's chunk chain. Return 409 with a structured status so
        //     the UI can surface "Local edits won't sync — fork or discard?".
        //   - any other throw: 500 reassemble_failed.
        const localJsonlPath = join(projectsRoot(), encodeCwd(targetCwd), `${sessionId}.jsonl`);
        try {
          await sessionSync.reassembleSessionJsonl(sessionId, localJsonlPath);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof LocalDivergedError) {
            sendJson(
              { status: "local_diverged", localJsonlPath, message },
              409,
            );
            return true;
          }
          sendJson(
            { error: "reassemble_failed", message },
            500,
          );
          return true;
        }

        sendJson({
          status: "ok",
          sessionId,
          localCwd: targetCwd,
          jsonlPath: localJsonlPath,
          command: `cd ${shellQuote(targetCwd)} && claude --resume ${sessionId}`,
        });
        return true;
      } catch (err) {
        sendError(err, 500);
        return true;
      }
    }
  }

  return false;
}

/** Minimal shell-safe quoting for paths surfaced in resume commands. We
 *  don't need a full shell-parser-grade escape — just wrap in single
 *  quotes and escape any embedded single quotes. */
function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(s)) return s;  // safe characters, no quotes needed
  return `'${s.replace(/'/g, "'\\''")}'`;
}
