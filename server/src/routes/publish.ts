// /api/artifacts/:id/publish — POST + DELETE.
// Thin glue layer over publish-service. Same precedent as routes/auth.ts.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { PublishService, PublishError } from "../publish-service.js";
import type { RouteCtx } from "../http-utils.js";
import { safeDecode } from "../http-utils.js";

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
  const { sendJson, rejectIfNonLocalOrigin, readJsonBody } = ctx;
  const artifactId = safeDecode(m[1]);
  if (artifactId === null) {
    sendJson({ error: "invalid_artifact_id", message: "Malformed URL encoding in artefact id." }, 400);
    return true;
  }

  if (req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return true;
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody();
    } catch (err) {
      // readJsonBody throws HttpError on malformed/oversized JSON. Without
      // this catch the rejection bubbles to handleHttpRequest and crashes.
      const status = (err && typeof err === "object" && "status" in err) ? (err as { status: number }).status : 400;
      const message = err instanceof Error ? err.message : "Could not read request body.";
      sendJson({ error: "invalid_request_body", message }, status);
      return true;
    }
    const mode = body.mode;
    if (mode !== "open" && mode !== "password" && mode !== "signin") {
      sendJson({ error: "invalid_mode", message: "mode must be open, password, or signin" }, 400);
      return true;
    }
    if (body.password !== undefined && typeof body.password !== "string") {
      sendJson({ error: "invalid_password_type", message: "password must be a string." }, 400);
      return true;
    }
    try {
      const result = await deps.publishService.publishArtifact({
        artifact_id: artifactId,
        mode,
        password: typeof body.password === "string" ? body.password : undefined,
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
