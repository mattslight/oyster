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

  // Step 6: find-or-claim final share_token.
  type ActiveRow = { share_token: string; published_at: number };
  const existing = await env.DB.prepare(
    `SELECT share_token, published_at FROM published_artifacts
      WHERE owner_user_id = ? AND artifact_id = ? AND unpublished_at IS NULL`
  ).bind(user.id, meta.artifact_id).first<ActiveRow>();

  let shareToken: string;
  let publishedAt: number;
  let path: "first-publish" | "upsert";

  if (existing) {
    shareToken = existing.share_token;
    publishedAt = existing.published_at;
    path = "upsert";
  } else {
    // Cap check before generating a token.
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM published_artifacts
        WHERE owner_user_id = ? AND unpublished_at IS NULL`
    ).bind(user.id).first<{ n: number }>();
    const current = countRow?.n ?? 0;
    if (current >= cap.max_active) {
      return jsonError(402, "publish_cap_exceeded",
        `Free tier allows ${cap.max_active} active published artefacts. Unpublish one first.`,
        { current, limit: cap.max_active });
    }

    // Generate token and try to claim it.
    const candidate = generateShareToken();
    const now = Date.now();
    try {
      await env.DB.prepare(
        `INSERT INTO published_artifacts
         (share_token, owner_user_id, artifact_id, artifact_kind, mode, password_hash,
          r2_key, content_type, size_bytes, published_at, updated_at, unpublished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      ).bind(
        candidate, user.id, meta.artifact_id, meta.artifact_kind, meta.mode,
        meta.password_hash ?? null,
        r2KeyFor(user.id, candidate),
        req.headers.get("Content-Type") ?? "application/octet-stream",
        contentLength, now, now,
      ).run();
      shareToken = candidate;
      publishedAt = now;
      path = "first-publish";
    } catch (err) {
      // Race recovery: concurrent first-publish for the same (owner, artifact) won.
      // Re-SELECT and treat as upsert.
      const won = await env.DB.prepare(
        `SELECT share_token, published_at FROM published_artifacts
          WHERE owner_user_id = ? AND artifact_id = ? AND unpublished_at IS NULL`
      ).bind(user.id, meta.artifact_id).first<ActiveRow>();
      if (!won) {
        // Some other constraint failed; surface as 500.
        console.error("[publish] insert failed and no winning row found:", err);
        return jsonError(500, "internal_error");
      }
      shareToken = won.share_token;
      publishedAt = won.published_at;
      path = "upsert";
    }
  }

  // Step 7: read body with size enforcement, then PUT to R2.
  const r2Key = r2KeyFor(user.id, shareToken);
  let putError: Error | null = null;
  let bodyBytes: Uint8Array = new Uint8Array(0);
  try {
    const stream = req.body;
    if (stream) {
      const result = await collectWithSizeCap(stream, cap.max_size_bytes);
      if (result.exceeded) {
        putError = new Error("artifact_too_large");
      } else {
        bodyBytes = result.bytes;
      }
    }
    if (!putError) {
      await env.ARTIFACTS.put(r2Key, bodyBytes, {
        httpMetadata: { contentType: req.headers.get("Content-Type") ?? "application/octet-stream" },
      });
    }
  } catch (err) {
    putError = err as Error;
  }

  if (putError) {
    // Rollback: delete the speculatively-inserted row only if first-publish.
    if (path === "first-publish") {
      await env.DB.prepare("DELETE FROM published_artifacts WHERE share_token = ?")
        .bind(shareToken).run();
    }
    // Best-effort R2 cleanup.
    try { await env.ARTIFACTS.delete(r2Key); } catch { /* swallow */ }

    if (putError.message === "artifact_too_large") {
      return jsonError(413, "artifact_too_large",
        "Free tier allows published artefacts up to 10 MB.",
        { limit_bytes: cap.max_size_bytes });
    }
    console.error("[publish] R2 put failed:", putError);
    return jsonError(502, "upload_failed");
  }

  // Step 8: D1 commit.
  if (path === "upsert") {
    const updatedAt = Date.now();
    await env.DB.prepare(
      `UPDATE published_artifacts
          SET mode = ?, password_hash = ?, content_type = ?, size_bytes = ?, updated_at = ?
        WHERE share_token = ?`
    ).bind(
      meta.mode, meta.password_hash ?? null,
      req.headers.get("Content-Type") ?? "application/octet-stream",
      contentLength, updatedAt, shareToken,
    ).run();

    // Step 9: respond (upsert path).
    return jsonOk({
      share_token: shareToken,
      share_url: `https://oyster.to/p/${shareToken}`,
      mode: meta.mode,
      published_at: publishedAt,
      updated_at: updatedAt,
    });
  } else {
    // First-publish: row already inserted with published_at = updated_at = now.
    // Return the same timestamp for both so published_at === updated_at on the wire.
    return jsonOk({
      share_token: shareToken,
      share_url: `https://oyster.to/p/${shareToken}`,
      mode: meta.mode,
      published_at: publishedAt,
      updated_at: publishedAt,
    });
  }
}

async function handlePublishDelete(req: Request, env: Env, shareToken: string): Promise<Response> {
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");

  type Row = { owner_user_id: string; r2_key: string; unpublished_at: number | null };
  const row = await env.DB.prepare(
    "SELECT owner_user_id, r2_key, unpublished_at FROM published_artifacts WHERE share_token = ?"
  ).bind(shareToken).first<Row>();

  if (!row) return jsonError(404, "publication_not_found");
  if (row.owner_user_id !== user.id) return jsonError(403, "not_publication_owner");

  if (row.unpublished_at !== null) {
    return jsonOk({ ok: true, share_token: shareToken, unpublished_at: row.unpublished_at });
  }

  const now = Date.now();
  await env.DB.prepare("UPDATE published_artifacts SET unpublished_at = ? WHERE share_token = ?")
    .bind(now, shareToken).run();

  // Best-effort R2 delete; D1 is the source of truth.
  try { await env.ARTIFACTS.delete(row.r2_key); } catch (err) {
    console.warn("[publish] R2 delete failed (orphan accepted):", err);
  }

  return jsonOk({ ok: true, share_token: shareToken, unpublished_at: now });
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

// collectWithSizeCap reads a ReadableStream into a Uint8Array, aborting if
// total bytes exceed `max`. Returns { bytes, exceeded }.
async function collectWithSizeCap(
  input: ReadableStream<Uint8Array>,
  max: number,
): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = input.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        reader.cancel();
        return { bytes: new Uint8Array(0), exceeded: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  // Concatenate all chunks.
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: out, exceeded: false };
}
