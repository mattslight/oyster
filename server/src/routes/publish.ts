// /api/artifacts/:id/publish — POST + DELETE.
// Thin glue layer over publish-service. Same precedent as routes/auth.ts.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { PublishService, PublishError } from "../publish-service.js";
import type { RouteCtx } from "../http-utils.js";

export interface PublishRouteDeps {
  publishService: PublishService;
}

const PATH_RE = /^\/api\/artifacts\/([^/]+)\/publish$/;

export async function tryHandlePublishRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: RouteCtx,
  deps: PublishRouteDeps,
): Promise<boolean> {
  const m = url.match(PATH_RE);
  if (!m) return false;
  const artifactId = decodeURIComponent(m[1]);
  const { sendJson, rejectIfNonLocalOrigin, readJsonBody } = ctx;

  if (req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return true;
    const body = await readJsonBody();
    const mode = body?.mode;
    if (mode !== "open" && mode !== "password" && mode !== "signin") {
      sendJson({ error: "invalid_mode", message: "mode must be open, password, or signin" }, 400);
      return true;
    }
    try {
      const result = await deps.publishService.publishArtifact({
        artifact_id: artifactId,
        mode,
        password: typeof body?.password === "string" ? body.password : undefined,
      });
      sendJson(result);
    } catch (err) {
      writePublishError(sendJson, err);
    }
    return true;
  }

  if (req.method === "DELETE") {
    if (rejectIfNonLocalOrigin()) return true;
    try {
      const result = await deps.publishService.unpublishArtifact({ artifact_id: artifactId });
      sendJson(result);
    } catch (err) {
      writePublishError(sendJson, err);
    }
    return true;
  }

  return false;
}

function writePublishError(sendJson: RouteCtx["sendJson"], err: unknown): void {
  if (err && typeof err === "object" && "status" in err && "code" in err) {
    const e = err as PublishError;
    sendJson({ error: e.code, message: e.message, ...e.details }, e.status);
    return;
  }
  console.error("[publish] unexpected error:", err);
  sendJson({ error: "internal_error" }, 500);
}
