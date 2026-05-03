// oyster-publish — R5 publish endpoints + viewer scaffold.
// Spec: docs/superpowers/specs/2026-05-03-r5-publish-backend-design.md

import type { Env, PublicationRow } from "./types";
import { CAPS, generateShareToken, parseMetadataHeader, r2KeyFor, type Tier } from "./publish-helpers";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/publish/upload" && req.method === "POST") {
      return handlePublishUpload(req, env);
    }

    if (url.pathname.startsWith("/api/publish/") && req.method === "DELETE") {
      const token = url.pathname.slice("/api/publish/".length);
      return handlePublishDelete(req, env, token);
    }

    if (url.pathname.startsWith("/p/") && req.method === "GET") {
      // Viewer body lands in #316.
      return jsonError(501, "not_implemented", "viewer lands in #316");
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ─── Handlers (bodies in tasks 2.5 and 2.6) ────────────────────────────────

async function handlePublishUpload(req: Request, env: Env): Promise<Response> {
  // Step 1: session.
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required", "Sign in to publish artefacts.");

  // Step 2: metadata.
  const metaHeader = req.headers.get("X-Publish-Metadata");
  if (!metaHeader) return jsonError(400, "invalid_metadata");
  let meta;
  try {
    meta = parseMetadataHeader(metaHeader);
  } catch {
    return jsonError(400, "invalid_metadata");
  }

  // Step 3: password presence iff mode=password (defence in depth — local server already checked).
  if (meta.mode === "password" && (!meta.password_hash || meta.password_hash.length === 0)) {
    return jsonError(400, "password_required");
  }
  if (meta.mode !== "password" && meta.password_hash) {
    // Local server bug: hash sent for non-password mode. Reject.
    return jsonError(400, "invalid_metadata");
  }

  // Step 4: Content-Length present.
  const lenHeader = req.headers.get("Content-Length");
  if (!lenHeader) return jsonError(411, "content_length_required");
  const contentLength = Number(lenHeader);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    return jsonError(411, "content_length_required");
  }

  // Step 5: tier + size cap.
  const tier = (user.tier in CAPS ? user.tier : "free") as Tier;
  const cap = CAPS[tier];
  if (contentLength > cap.max_size_bytes) {
    return jsonError(413, "artifact_too_large", "Free tier allows published artefacts up to 10 MB.", {
      limit_bytes: cap.max_size_bytes,
    });
  }

  // Steps 6–9 land in Task 2.6.
  return jsonError(501, "not_implemented", "find-or-claim + R2 PUT + D1 upsert — Task 2.6");
}

async function handlePublishDelete(req: Request, env: Env, shareToken: string): Promise<Response> {
  return jsonError(501, "not_implemented", "publish_unpublish — body in Task 2.6");
}

// ─── Shared helpers ────────────────────────────────────────────────────────

interface SessionUser {
  id: string;
  email: string;
  tier: string;
}

/**
 * Resolve the session cookie to a user. Returns null on missing/expired session.
 * Reads from the shared sessions + users tables.
 */
export async function resolveSession(req: Request, env: Env): Promise<SessionUser | null> {
  const cookie = req.headers.get("Cookie");
  if (!cookie) return null;
  const m = cookie.match(/(?:^|;\s*)oyster_session=([^;]+)/);
  if (!m) return null;
  const token = m[1];

  const row = await env.DB.prepare(
    `SELECT u.id AS id, u.email AS email, u.tier AS tier, s.expires_at AS expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.session_token = ?`
  ).bind(token).first<{ id: string; email: string; tier: string; expires_at: number }>();

  if (!row) return null;
  if (row.expires_at <= Date.now()) return null;
  return { id: row.id, email: row.email, tier: row.tier };
}

export function jsonError(status: number, code: string, message?: string, extra: Record<string, unknown> = {}): Response {
  const body: Record<string, unknown> = { error: code, ...extra };
  if (message) body.message = message;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function jsonOk(payload: object, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
