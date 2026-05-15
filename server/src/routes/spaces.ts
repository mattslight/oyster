// /api/spaces/* — extracted from index.ts AND the legacy spaces-routes.ts.
//
// Pre-audit, the spaces handlers were split: 3 lived in spaces-routes.ts
// using the old req.on("data")/req.on("end") callback shape, the rest were
// inline in index.ts using the newer async readJsonBody. This module
// collapses both into one place using RouteCtx — same body-reading style
// as the sessions and artifacts buckets.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SpaceService } from "../space-service.js";
import { SourcePathConflictError } from "../space-service.js";
import { existsSync, statSync } from "node:fs";
import type { UiCommand } from "../../../shared/types.js";
import type { RouteCtx } from "../http-utils.js";
import { safeDecode } from "../http-utils.js";
import { slugify } from "../utils.js";

export interface SpaceRouteDeps {
  spaceService: SpaceService;
  /** Broadcasts SSE so connected clients refetch — used after lifecycle
   *  changes that re-attribute sessions (DELETE space cascades; from-path
   *  re-claims orphan sessions whose cwd matches). */
  broadcastUiEvent: (event: UiCommand) => void;
}

export async function tryHandleSpaceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: RouteCtx,
  deps: SpaceRouteDeps,
): Promise<boolean> {
  const { sendJson, sendError, readJsonBody, rejectIfNonLocalOrigin } = ctx;
  const { spaceService, broadcastUiEvent } = deps;

  // GET /api/spaces — list all spaces
  if (url === "/api/spaces" && req.method === "GET") {
    if (rejectIfNonLocalOrigin()) return true;
    sendJson(spaceService.listSpaces());
    return true;
  }

  // POST /api/spaces/from-folder — convert a folder group (under home) into
  // its own space. Used by the desktop right-click "Move folder to space" flow.
  if (url === "/api/spaces/from-folder" && req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return true;
    try {
      const body = await readJsonBody();
      const folderName = typeof body.folderName === "string" ? body.folderName : null;
      const sourceSpaceId = typeof body.sourceSpaceId === "string" ? body.sourceSpaceId : "home";
      const merge = body.merge === true;
      if (!folderName) {
        sendJson({ error: "folderName is required" }, 400);
        return true;
      }
      let space: ReturnType<typeof spaceService.getSpace>;
      const existing = spaceService.getSpace(slugify(folderName));
      if (existing && merge) {
        space = existing;
      } else {
        space = spaceService.createSpace({ name: folderName });
      }
      spaceService.convertFolderToSpace(sourceSpaceId, folderName, space!.id);
      sendJson(space, existing && merge ? 200 : 201);
    } catch (err) {
      sendError(err);
    }
    return true;
  }

  // POST /api/spaces/from-path — one-shot "promote folder to space": create
  // a new space named after the folder, attach the path as its sole source,
  // and re-attribute orphan sessions whose cwd matches. Local-origin gated +
  // size-capped — accepts a filesystem path so it inherits the same
  // hardening as /api/spaces/:id/sources POST.
  if (url === "/api/spaces/from-path" && req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return true;
    try {
      const body = await readJsonBody();
      const path = typeof body.path === "string" ? body.path.trim() : "";
      const name = typeof body.name === "string" ? body.name.trim() : undefined;
      if (!path) {
        sendJson({ error: "path is required" }, 400);
        return true;
      }
      const { space } = spaceService.createSpaceFromPath({ path, name });
      // Tell connected clients to refetch sessions — the backfill just
      // moved orphan rows from `(NULL, NULL)` to `(space, source)` and the
      // hook only otherwise refreshes when the watcher fires.
      broadcastUiEvent({ version: 1, command: "session_changed", payload: { id: "" } });
      sendJson(space, 201);
      // Defer the initial scan to the next tick so the 201 above flushes
      // before scanSpace's synchronous fs walk + sqlite work starts. Without
      // this, big folders block the event loop long enough that the response
      // can't reach the client until the scan finishes — the UI sees the
      // attach as a hang. Artefacts still surface via SSE as the scan runs.
      setImmediate(() => {
        spaceService.scanSpace(space.id).catch((err) => {
          console.warn("[from-path] scan failed:", err instanceof Error ? err.message : err);
        });
      });
    } catch (err) {
      sendError(err);
    }
    return true;
  }

  // /api/spaces/:id/sources — active sources (linked folders) for a
  // space. Local-origin only: paths leak the user's home directory.
  // Surfaces #266 plus attach/detach from the Folders section.
  {
    const sourcesPath = url.split("?")[0];
    const m = sourcesPath.match(/^\/api\/spaces\/([^/]+)\/sources$/);
    if (m && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return true;
      const spaceId = safeDecode(m[1]);
      if (spaceId === null) { sendJson({ error: "Invalid URL encoding" }, 400); return true; }
      try {
        sendJson(spaceService.getSources(spaceId));
      } catch (err) {
        sendError(err, 500);
      }
      return true;
    }
    // POST /api/spaces/:id/sources — { path } attaches a folder. Mirrors
    // the chat-bar `onboard_space` flow: addSource then scan so artefacts
    // surface in the same round-trip.
    if (m && req.method === "POST") {
      if (rejectIfNonLocalOrigin()) return true;
      const spaceId = safeDecode(m[1]);
      if (spaceId === null) { sendJson({ error: "Invalid URL encoding" }, 400); return true; }
      try {
        const body = await readJsonBody();
        const path = typeof body.path === "string" ? body.path.trim() : "";
        if (!path) {
          sendJson({ error: "path is required" }, 400);
          return true;
        }
        const source = spaceService.addSource(spaceId, path);
        // addSource backfills orphan sessions whose cwd matches — tell
        // connected clients to refetch so the Unsorted tile disappears
        // immediately rather than waiting for the next watcher tick.
        // Mirrors the from-path route.
        broadcastUiEvent({ version: 1, command: "session_changed", payload: { id: "" } });
        sendJson(source, 201);
        // Defer to next tick so the 201 flushes before scanSpace's
        // synchronous fs walk starts (see /from-path comment).
        setImmediate(() => {
          spaceService.scanSpace(spaceId).catch((err) => {
            console.warn("[attach-source] scan failed:", err instanceof Error ? err.message : err);
          });
        });
      } catch (err) {
        sendError(err);
      }
      return true;
    }
    // DELETE /api/spaces/:id/sources/:source_id — detach a folder.
    // Soft-deletes the source row AND every artifact that came from it.
    const dm = sourcesPath.match(/^\/api\/spaces\/([^/]+)\/sources\/([^/]+)$/);
    if (dm && req.method === "DELETE") {
      if (rejectIfNonLocalOrigin()) return true;
      const spaceId = safeDecode(dm[1]);
      const sourceId = safeDecode(dm[2]);
      if (spaceId === null || sourceId === null) {
        sendJson({ error: "Invalid URL encoding" }, 400);
        return true;
      }
      try {
        const source = spaceService.getSourceById(sourceId);
        if (!source || source.space_id !== spaceId) {
          sendJson({ error: "source not found in this space" }, 404);
          return true;
        }
        spaceService.removeSource(sourceId);
        // Sessions previously bound to this source are now orphan; tell
        // connected clients to refetch so the home feed reflects the
        // detach without waiting for the next watcher tick.
        broadcastUiEvent({ version: 1, command: "session_changed", payload: { id: "" } });
        res.writeHead(204);
        res.end();
      } catch (err) {
        sendError(err);
      }
      return true;
    }
    // PATCH /api/spaces/:id/sources/:source_id — update a source's path
    // (folder rename / unmounted-drive recovery) and/or label. Existing
    // bindings are preserved; the longest-prefix heuristic runs after a
    // path change so orphan auto-sessions matching the new path get bound
    // and auto-sessions move to a more specific source when one applies.
    //
    // If the new path is already attached to another source in this space,
    // the user almost certainly wants to *merge* this source into that one
    // rather than rename — we return 409 with a structured
    // `would_consolidate` body so the UI can offer the merge.
    if (dm && req.method === "PATCH") {
      if (rejectIfNonLocalOrigin()) return true;
      const spaceId = safeDecode(dm[1]);
      const sourceId = safeDecode(dm[2]);
      if (spaceId === null || sourceId === null) {
        sendJson({ error: "Invalid URL encoding" }, 400);
        return true;
      }
      try {
        const source = spaceService.getSourceById(sourceId);
        // Detached sources are 404 too: callers shouldn't be able to PATCH
        // a row we've soft-deleted. Mirrors DELETE's "active only" guard.
        if (!source || source.space_id !== spaceId || source.removed_at) {
          sendJson({ error: "source not found in this space" }, 404);
          return true;
        }
        const body = await readJsonBody();
        const fields: { path?: string; label?: string | null } = {};
        if (body.path !== undefined) {
          if (typeof body.path !== "string" || body.path.trim().length === 0) {
            sendJson({ error: "path must be a non-empty string" }, 400);
            return true;
          }
          fields.path = body.path.trim();
        }
        if (body.label !== undefined) {
          if (body.label === null) fields.label = null;
          else if (typeof body.label === "string") fields.label = body.label;
          else {
            sendJson({ error: "label must be a string or null" }, 400);
            return true;
          }
        }
        try {
          const updated = spaceService.updateSource(sourceId, fields);
          broadcastUiEvent({ version: 1, command: "session_changed", payload: { id: "" } });
          // Compute pathExists from the actual updated path — non-existent
          // paths are accepted (unmounted drives / renamed folders), so a
          // hardcoded `true` would lie to the client for one render cycle
          // until the next GET. Match the same safe stat the GET uses.
          let pathExists = false;
          try { pathExists = existsSync(updated.path) && statSync(updated.path).isDirectory(); }
          catch { /* slow drive / EACCES — advisory only, false is fine */ }
          sendJson({ ...updated, pathExists });
        } catch (err) {
          if (err instanceof SourcePathConflictError) {
            const summary = spaceService.sourceContentSummary(source.id);
            sendJson({
              error: "would_consolidate",
              target: {
                id: err.conflict.id,
                space_id: err.conflict.space_id,
                path: err.conflict.path,
                label: err.conflict.label,
              },
              source: { id: err.source.id, label: err.source.label, path: err.source.path },
              moves: summary,
              sameSpace: err.conflict.space_id === err.source.space_id,
            }, 409);
            return true;
          }
          throw err;
        }
      } catch (err) {
        sendError(err);
      }
      return true;
    }
    // POST /api/spaces/:id/sources/:source_id/consolidate { intoSourceId }
    // — merge this source into the target: bulk-reassign sessions +
    // artefacts, then soft-delete this source. Both must be in the same
    // space. Returns the move counts.
    const cm = sourcesPath.match(/^\/api\/spaces\/([^/]+)\/sources\/([^/]+)\/consolidate$/);
    if (cm && req.method === "POST") {
      if (rejectIfNonLocalOrigin()) return true;
      const spaceId = safeDecode(cm[1]);
      const sourceId = safeDecode(cm[2]);
      if (spaceId === null || sourceId === null) {
        sendJson({ error: "Invalid URL encoding" }, 400);
        return true;
      }
      try {
        const source = spaceService.getSourceById(sourceId);
        if (!source || source.space_id !== spaceId || source.removed_at) {
          sendJson({ error: "source not found in this space" }, 404);
          return true;
        }
        const body = await readJsonBody();
        const intoSourceId = typeof body.intoSourceId === "string" ? body.intoSourceId : "";
        if (!intoSourceId) {
          sendJson({ error: "intoSourceId is required" }, 400);
          return true;
        }
        const result = spaceService.consolidateSource(sourceId, intoSourceId);
        broadcastUiEvent({ version: 1, command: "session_changed", payload: { id: "" } });
        sendJson({
          sessionsMoved: result.sessionsMoved,
          artefactsMoved: result.artefactsMoved,
          into: result.intoSource,
        });
      } catch (err) {
        sendError(err);
      }
      return true;
    }
  }

  // PATCH /api/spaces/:id — rename / recolour
  // DELETE /api/spaces/:id — soft-delete; cascades to sessions.space_id = NULL
  {
    const m = url.match(/^\/api\/spaces\/([^/]+)$/);
    if (m && req.method === "PATCH") {
      if (rejectIfNonLocalOrigin()) return true;
      const spaceId = safeDecode(m[1]);
      if (spaceId === null) { sendJson({ error: "Invalid URL encoding" }, 400); return true; }
      try {
        const body = await readJsonBody();
        const displayName = typeof body.displayName === "string" ? body.displayName : undefined;
        const color = typeof body.color === "string" ? body.color : undefined;
        const updated = spaceService.updateSpace(spaceId, { displayName, color });
        sendJson(updated);
      } catch (err) {
        sendError(err);
      }
      return true;
    }
    if (m && req.method === "DELETE") {
      if (rejectIfNonLocalOrigin()) return true;
      const spaceId = safeDecode(m[1]);
      if (spaceId === null) { sendJson({ error: "Invalid URL encoding" }, 400); return true; }
      try {
        const body = await readJsonBody();
        const folderName = typeof body.folderName === "string" ? body.folderName : undefined;
        spaceService.deleteSpace(spaceId, folderName);
        // Cascade fired sessions.space_id → NULL on every session in the
        // deleted space. Tell connected clients to refetch the session
        // list so the UI moves them back to Elsewhere immediately rather
        // than waiting for the next watcher tick.
        broadcastUiEvent({ version: 1, command: "session_changed", payload: { id: "" } });
        res.writeHead(204);
        res.end();
      } catch (err) {
        sendError(err);
      }
      return true;
    }
  }

  return false;
}
