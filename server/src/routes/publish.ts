// /api/artifacts/:id/publish — POST + DELETE.
// Thin glue layer over publish-service. Same precedent as routes/auth.ts.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { PublishService, PublishError } from "../publish-service.js";
import type { RouteCtx } from "../http-utils.js";
import type { UiCommand } from "../../../shared/types.js";
import { safeDecode } from "../http-utils.js";

export interface PublishRouteDeps {
  publishService: PublishService;
  broadcastUiEvent: (event: UiCommand) => void;
}

const PATH_RE = /^\/api\/artifacts\/([^/]+)\/publish$/;
const BY_TOKEN_RE = /^\/api\/publish\/by-token\/([^/]+)\/unpublish$/;
const BY_TOKEN_UPDATE_RE = /^\/api\/publish\/by-token\/([^/]+)\/update$/;

export async function tryHandlePublishRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: RouteCtx,
  deps: PublishRouteDeps,
): Promise<boolean> {
  // Cloud-only unpublish: retire a publication by share_token, no local
  // artefact required. Lets a user manage their cloud publications from any
  // signed-in device — without this, a publication minted on machine A is
  // un-retire-able from machine B.
  const byTok = url.match(BY_TOKEN_RE);
  if (byTok && req.method === "POST") {
    const { sendJson, rejectIfNonLocalOrigin } = ctx;
    if (rejectIfNonLocalOrigin()) return true;
    const shareToken = safeDecode(byTok[1]);
    if (shareToken === null) {
      sendJson({ error: "invalid_share_token", message: "Malformed URL encoding in share token." }, 400);
      return true;
    }
    try {
      const result = await deps.publishService.unpublishByShareToken(shareToken);
      sendJson(result);
      // No local artefact to broadcast against; the cloud-only cache will
      // refresh on the next backfill (and the surface refetches on
      // artifact_changed).
      deps.broadcastUiEvent({ version: 1, command: "artifact_changed", payload: { id: null } });
    } catch (err) {
      writePublishError(sendJson, err);
    }
    return true;
  }

  // Cloud-only update: change mode/password without re-uploading bytes. Lets
  // a publication's access settings be reset from any signed-in device, even
  // when this device has no local copy of the underlying artefact.
  const byTokUpdate = url.match(BY_TOKEN_UPDATE_RE);
  if (byTokUpdate && req.method === "POST") {
    const { sendJson, rejectIfNonLocalOrigin, readJsonBody } = ctx;
    if (rejectIfNonLocalOrigin()) return true;
    const shareToken = safeDecode(byTokUpdate[1]);
    if (shareToken === null) {
      sendJson({ error: "invalid_share_token", message: "Malformed URL encoding in share token." }, 400);
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody();
    } catch (err) {
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
      const result = await deps.publishService.updateShareByToken({
        share_token: shareToken,
        mode,
        password: typeof body.password === "string" ? body.password : undefined,
      });
      sendJson(result);
      deps.broadcastUiEvent({ version: 1, command: "artifact_changed", payload: { id: null } });
    } catch (err) {
      writePublishError(sendJson, err);
    }
    return true;
  }

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
      deps.broadcastUiEvent({ version: 1, command: "artifact_changed", payload: { id: artifactId } });
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
      deps.broadcastUiEvent({ version: 1, command: "artifact_changed", payload: { id: artifactId } });
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
