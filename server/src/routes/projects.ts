// /api/projects/* — the HTTP surface for the projects identity model.
// Replaces /api/spaces/:id/sources* during the sources→projects cut.
//
// Endpoints:
//   GET  /api/projects?space_id=X         list active projects in space X
//   POST /api/projects                    create a project { space_id, name }
//   POST /api/projects/attach-folder      idempotent attach { space_id, path,
//                                          name? } — writes .oyster/id, claims
//                                          orphans, undeletes a soft-deleted
//                                          project whose UUID is on disk
//   POST /api/projects/:id/claim          bulk-tag orphan sessions { cwd }
//   PATCH /api/projects/:id               rename
//   DELETE /api/projects/:id              soft-delete

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProjectService } from "../project-service.js";
import type { UiCommand } from "../../../shared/types.js";
import type { RouteCtx } from "../http-utils.js";
import { safeDecode } from "../http-utils.js";

export interface ProjectsRouteDeps {
  projectService: ProjectService;
  broadcastUiEvent: (event: UiCommand) => void;
}

export async function tryHandleProjectsRoute(
  req: IncomingMessage,
  _res: ServerResponse,
  url: string,
  ctx: RouteCtx,
  deps: ProjectsRouteDeps,
): Promise<boolean> {
  const { sendJson, sendError, readJsonBody, rejectIfNonLocalOrigin } = ctx;
  const { projectService, broadcastUiEvent } = deps;

  // Split off the query string so URL matching stays simple. URLSearchParams
  // for read params keeps the parsing cheap and forgiving.
  const qIdx = url.indexOf("?");
  const pathname = qIdx >= 0 ? url.slice(0, qIdx) : url;
  const query = qIdx >= 0 ? new URLSearchParams(url.slice(qIdx + 1)) : new URLSearchParams();

  if (pathname === "/api/projects" && req.method === "GET") {
    if (rejectIfNonLocalOrigin()) return true;
    try {
      const spaceId = query.get("space_id");
      if (!spaceId) {
        sendJson({ error: "space_id query parameter is required" }, 400);
        return true;
      }
      sendJson(projectService.listForSpace(spaceId));
    } catch (err) { sendError(err); }
    return true;
  }

  if (pathname === "/api/projects" && req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return true;
    try {
      const body = await readJsonBody();
      const spaceId = typeof body.space_id === "string" ? body.space_id : null;
      const name = typeof body.name === "string" ? body.name : null;
      if (!spaceId || !name) {
        sendJson({ error: "space_id and name are required" }, 400);
        return true;
      }
      const project = projectService.createProject({ spaceId, name });
      // session_changed forces the UI to re-fetch the spaces/sessions view —
      // a new project (especially one paired with a claim_orphan) can shift
      // session attribution under existing tiles.
      broadcastUiEvent({ version: 1, command: "session_changed", payload: { id: "" } });
      sendJson(project, 201);
    } catch (err) { sendError(err); }
    return true;
  }

  if (pathname === "/api/projects/attach-folder" && req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return true;
    try {
      const body = await readJsonBody();
      const spaceId = typeof body.space_id === "string" ? body.space_id : null;
      const path = typeof body.path === "string" ? body.path.trim() : "";
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
      if (!spaceId || !path) {
        sendJson({ error: "space_id and path are required" }, 400);
        return true;
      }
      const result = projectService.attachFolder({ spaceId, path, name });
      broadcastUiEvent({ version: 1, command: "session_changed", payload: { id: "" } });
      sendJson(result, 201);
    } catch (err) { sendError(err); }
    return true;
  }

  const idMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (idMatch && (req.method === "DELETE" || req.method === "PATCH")) {
    if (rejectIfNonLocalOrigin()) return true;
    try {
      const projectId = safeDecode(idMatch[1]!);
      if (projectId === null) { sendJson({ error: "Invalid URL encoding" }, 400); return true; }
      if (req.method === "DELETE") {
        projectService.deleteProject(projectId);
        broadcastUiEvent({ version: 1, command: "session_changed", payload: { id: "" } });
        sendJson({ ok: true });
      } else {
        const body = await readJsonBody();
        const updated = projectService.updateProject(projectId, {
          name: typeof body.name === "string" ? body.name : undefined,
        });
        broadcastUiEvent({ version: 1, command: "session_changed", payload: { id: "" } });
        sendJson(updated);
      }
    } catch (err) { sendError(err); }
    return true;
  }

  const claimMatch = pathname.match(/^\/api\/projects\/([^/]+)\/claim$/);
  if (claimMatch && req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return true;
    try {
      const projectId = safeDecode(claimMatch[1]!);
      if (projectId === null) {
        sendJson({ error: "Invalid URL encoding" }, 400);
        return true;
      }
      const body = await readJsonBody();
      const cwd = typeof body.cwd === "string" ? body.cwd : null;
      if (!cwd) {
        sendJson({ error: "cwd is required" }, 400);
        return true;
      }
      const result = projectService.claimOrphan({ cwd, projectId });
      broadcastUiEvent({ version: 1, command: "session_changed", payload: { id: "" } });
      sendJson(result);
    } catch (err) { sendError(err); }
    return true;
  }

  return false;
}
