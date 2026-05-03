// oyster-publish — R5 publish endpoints + viewer scaffold.
// Spec: docs/superpowers/specs/2026-05-03-r5-publish-backend-design.md

import type { Env, PublicationRow } from "./types";
import { CAPS, generateShareToken, parseMetadataHeader, parseShareTokenPath, r2KeyFor, type Tier } from "./publish-helpers";
import { resolveViewerAccess } from "./viewer-access";
import { signViewerCookie } from "./viewer-cookie";
import {
  passwordGatePage, gonePage, notFoundPage, internalErrorPage, rateLimitedPage,
} from "./viewer-pages";
import {
  renderMarkdownPage, renderMermaidPage, renderChromeWithIframe, renderRawHtmlBody, renderImageInline,
} from "./viewer-render";

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

    if (url.pathname.startsWith("/p/")) {
      const parsed = parseShareTokenPath(url.pathname);
      if (!parsed) return new Response("Not Found", { status: 404 });
      if (req.method === "GET" && parsed.raw) {
        return handleViewerRaw(req, env, parsed.shareToken);
      }
      if (req.method === "GET") {
        return handleViewerGet(req, env, parsed.shareToken);
      }
      if (req.method === "POST" && !parsed.raw) {
        return handleViewerPost(req, env, parsed.shareToken);
      }
      return new Response("Method Not Allowed", { status: 405 });
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

  // Step 4: Content-Length present and well-formed.
  // Reject non-digit headers (e.g. "1.5", "1e6", "-3", " 42 ") — these would slip
  // past Number() but corrupt size_bytes. The spec wants an explicit decimal-digit
  // string. Final source of truth for size_bytes is the actual streamed byteLength
  // (set in step 8); contentLength here is just the cap-check estimate.
  const lenHeader = req.headers.get("Content-Length");
  if (!lenHeader || !/^\d+$/.test(lenHeader)) return jsonError(411, "content_length_required");
  const contentLength = Number(lenHeader);
  if (!Number.isSafeInteger(contentLength)) return jsonError(411, "content_length_required");

  // Step 5: tier + size cap. Use Object.hasOwn so prototype keys (toString etc.)
  // can't masquerade as a tier and produce an undefined cap.
  const tier = (Object.hasOwn(CAPS, user.tier) ? user.tier : "free") as Tier;
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

  // Step 8: D1 commit. size_bytes is reconciled to the actual number of bytes
  // we just wrote to R2 (Content-Length is client-controlled and may have lied
  // within the cap; bodyBytes.byteLength is what's actually in the bucket).
  const actualSize = bodyBytes.byteLength;
  if (path === "upsert") {
    const updatedAt = Date.now();
    await env.DB.prepare(
      `UPDATE published_artifacts
          SET mode = ?, password_hash = ?, content_type = ?, size_bytes = ?, updated_at = ?
        WHERE share_token = ?`
    ).bind(
      meta.mode, meta.password_hash ?? null,
      req.headers.get("Content-Type") ?? "application/octet-stream",
      actualSize, updatedAt, shareToken,
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
    // First-publish: row was inserted in step 6 with size_bytes = contentLength
    // (the header value). Reconcile to actual streamed byteLength so D1 matches
    // what's in R2.
    if (actualSize !== contentLength) {
      await env.DB.prepare(
        `UPDATE published_artifacts SET size_bytes = ? WHERE share_token = ?`
      ).bind(actualSize, shareToken).run();
    }
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

  // Production sessions schema (infra/auth-worker/migrations/0001_init.sql):
  //   id TEXT PRIMARY KEY (the cookie value), user_id, created_at,
  //   expires_at, revoked_at. Live-row predicate matches auth-worker exactly:
  //   revoked_at IS NULL AND expires_at > now.
  const row = await env.DB.prepare(
    `SELECT u.id AS id, u.email AS email, u.tier AS tier
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ?`
  ).bind(token, Date.now()).first<{ id: string; email: string; tier: string }>();

  if (!row) return null;
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

// ─── Viewer handlers (#316) ────────────────────────────────────────────────

async function handleViewerGet(req: Request, env: Env, shareToken: string): Promise<Response> {
  const access = await resolveViewerAccess(req, env, shareToken);
  switch (access.kind) {
    case "not_found":
      return htmlPage(404, notFoundPage());
    case "gone":
      return htmlPage(410, gonePage());
    case "redirect":
      return new Response(null, {
        status: 302,
        headers: { location: access.location, "cache-control": "private, no-store" },
      });
    case "gate":
      return htmlPage(200, passwordGatePage(shareToken));
    case "ok":
      return renderForRow(env, access.row, req);
  }
}

async function handleViewerRaw(req: Request, env: Env, shareToken: string): Promise<Response> {
  const access = await resolveViewerAccess(req, env, shareToken);
  if (access.kind === "not_found") return htmlPage(404, notFoundPage());
  if (access.kind === "gone") return htmlPage(410, gonePage());
  if (access.kind === "redirect") {
    return new Response(null, { status: 302, headers: { location: access.location, "cache-control": "private, no-store" } });
  }
  if (access.kind === "gate") return htmlPage(200, passwordGatePage(shareToken));
  // OK — serve raw bytes for HTML kinds, or fall through for non-HTML
  const obj = await env.ARTIFACTS.get(access.row.r2_key);
  if (!obj) {
    console.error("[viewer] R2 object missing for token", shareToken, "key", access.row.r2_key);
    return htmlPage(500, internalErrorPage());
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  return renderRawHtmlBody(bytes, access.row);
}

async function handleViewerPost(req: Request, env: Env, shareToken: string): Promise<Response> {
  const access = await resolveViewerAccess(req, env, shareToken);
  if (access.kind === "not_found") return htmlPage(404, notFoundPage());
  if (access.kind === "gone") return htmlPage(410, gonePage());
  if (access.kind === "redirect") {
    return new Response(null, { status: 302, headers: { location: access.location, "cache-control": "private, no-store" } });
  }
  // POST is only meaningful in password mode.
  // For password: gate state OR ok state both indicate "the visitor wants
  // to (re-)authenticate via the form" — accept the POST. For other modes
  // (open/signin), POST is method-not-allowed.
  if (access.kind !== "gate" && !(access.kind === "ok" && access.row.mode === "password")) {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const row = (access as { row: PublicationRow }).row;

  // Rate limit per IP + token.
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const gate = await env.VIEWER_PASSWORD_LIMIT.limit({ key: `${ip}:${shareToken}` });
  if (!gate.success) return htmlPage(429, rateLimitedPage());

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return htmlPage(200, passwordGatePage(shareToken, { error: "wrong_password" }));
  }
  const password = form.get("password");
  if (typeof password !== "string" || password.length === 0) {
    return htmlPage(200, passwordGatePage(shareToken, { error: "wrong_password" }));
  }

  if (!row.password_hash) {
    console.error("[viewer] password mode row has no password_hash:", shareToken);
    return htmlPage(500, internalErrorPage());
  }
  const ok = await verifyPbkdf2(password, row.password_hash);
  if (!ok) {
    return htmlPage(200, passwordGatePage(shareToken, { error: "wrong_password" }));
  }

  const cookieValue = await signViewerCookie(shareToken, env.VIEWER_COOKIE_SECRET);
  return new Response(null, {
    status: 302,
    headers: {
      "set-cookie": `oyster_view_${shareToken}=${cookieValue}; HttpOnly; Secure; SameSite=Lax; Path=/p/${shareToken}; Max-Age=86400`,
      "location": `/p/${shareToken}`,
      "cache-control": "private, no-store",
    },
  });
}

async function renderForRow(env: Env, row: PublicationRow, req?: Request): Promise<Response> {
  // Short-circuit on If-None-Match (open mode only — others are no-store).
  if (req && row.mode === "open") {
    const ifNoneMatch = req.headers.get("If-None-Match");
    const etag = `W/"${row.share_token}-${row.updated_at}"`;
    if (ifNoneMatch && ifNoneMatch === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          etag,
          "cache-control": "public, max-age=60, must-revalidate",
        },
      });
    }
  }

  const obj = await env.ARTIFACTS.get(row.r2_key);
  if (!obj) {
    console.error("[viewer] R2 object missing for token", row.share_token, "key", row.r2_key);
    return htmlPage(500, internalErrorPage());
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());

  if (row.content_type.startsWith("image/")) return renderImageInline(bytes, row);

  switch (row.artifact_kind) {
    case "notes":
      return renderMarkdownPage(bytes, row);
    case "diagram":
      return renderMermaidPage(bytes, row);
    case "app":
    case "deck":
    case "wireframe":
    case "table":
    case "map":
      return renderChromeWithIframe(row);
    default:
      return row.content_type.startsWith("text/")
        ? renderMarkdownPage(bytes, row)
        : renderChromeWithIframe(row);
  }
}

function htmlPage(status: number, body: string): Response {
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  return new Response(body, { status, headers });
}

// PBKDF2-SHA256 verify, matches server/src/password-hash.ts producer.
async function verifyPbkdf2(plaintext: string, encoded: string): Promise<boolean> {
  // Format: pbkdf2$<iter>$<salt_b64url>$<hash_b64url>
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const [, iterRaw, saltB64, hashB64] = parts as [string, string, string, string];
  const iter = Number(iterRaw);
  if (!Number.isSafeInteger(iter) || iter < 1) return false;
  const salt = base64urlDecode(saltB64);
  const expected = base64urlDecode(hashB64);
  if (!salt || !expected) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(plaintext),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const derived = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
    key,
    expected.byteLength * 8,
  ));
  if (derived.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < derived.length; i++) diff |= (derived[i] as number) ^ (expected[i] as number);
  return diff === 0;
}

function base64urlDecode(s: string): Uint8Array | null {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
