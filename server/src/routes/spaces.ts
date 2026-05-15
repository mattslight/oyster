// /api/spaces/* — extracted from index.ts AND the legacy spaces-routes.ts.
//
// Pre-audit, the spaces handlers were split: 3 lived in spaces-routes.ts
// using the old req.on("data")/req.on("end") callback shape, the rest were
// inline in index.ts using the newer async readJsonBody. This module
// collapses both into one place using RouteCtx — same body-reading style
// as the sessions and artifacts buckets.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SpaceService } from "../space-service.js";
import type { ProjectService } from "../project-service.js";
import type { UiCommand } from "../../../shared/types.js";
import type { RouteCtx } from "../http-utils.js";
import { safeDecode } from "../http-utils.js";
import { slugify } from "../utils.js";

export interface SpaceRouteDeps {
  spaceService: SpaceService;
  projectService: ProjectService;
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
  const { spaceService, projectService, broadcastUiEvent } = deps;

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
  // a new space named after the folder, create a project for the path
  // (writing .oyster/id), and claim orphan sessions whose cwd matches.
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
      const space = spaceService.createSpace({ name: name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? "Untitled" });
      try {
        projectService.attachFolder({ spaceId: space.id, path });
      } catch (err) {
        // Roll back the empty space on attach failure.
        try { spaceService.deleteSpace(space.id); } catch { /* best-effort */ }
        throw err;
      }
      broadcastUiEvent({ version: 1, command: "session_changed", payload: { id: "" } });
      sendJson(space, 201);
    } catch (err) {
      sendError(err);
    }
    return true;
  }

  // /api/spaces/:id/sources/* are gone — the UI moved to /api/projects/*.

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
