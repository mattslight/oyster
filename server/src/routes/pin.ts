// /api/artifacts/:id/pin — POST + DELETE.
// Mirrors the publish route's shape (#317) — thin glue over artifact-service,
// SSE-broadcasts artifact_changed so the surface re-sorts pinned-first.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArtifactService } from "../artifact-service.js";
import type { RouteCtx } from "../http-utils.js";
import type { UiCommand } from "../../../shared/types.js";
import { safeDecode } from "../http-utils.js";

export interface PinRouteDeps {
  artifactService: ArtifactService;
  broadcastUiEvent: (event: UiCommand) => void;
}

const PATH_RE = /^\/api\/artifacts\/([^/]+)\/pin$/;

export async function tryHandlePinRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: RouteCtx,
  deps: PinRouteDeps,
): Promise<boolean> {
  const m = url.match(PATH_RE);
  if (!m) return false;
  const { sendJson, sendError, rejectIfNonLocalOrigin } = ctx;
  const artifactId = safeDecode(m[1]);
  if (artifactId === null) {
    sendJson({ error: "invalid_artifact_id", message: "Malformed URL encoding in artefact id." }, 400);
    return true;
  }

  if (req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return true;
    try {
      const result = deps.artifactService.pinArtifact(artifactId);
      sendJson(result);
      deps.broadcastUiEvent({ version: 1, command: "artifact_changed", payload: { id: artifactId } });
    } catch (err) {
      sendError(err);
    }
    return true;
  }

  if (req.method === "DELETE") {
    if (rejectIfNonLocalOrigin()) return true;
    try {
      const result = deps.artifactService.unpinArtifact(artifactId);
      sendJson(result);
      deps.broadcastUiEvent({ version: 1, command: "artifact_changed", payload: { id: artifactId } });
    } catch (err) {
      sendError(err);
    }
    return true;
  }

  return false;
}
