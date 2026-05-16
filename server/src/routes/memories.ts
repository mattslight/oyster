// /api/memories — extracted from index.ts. Two endpoints, both
// local-origin only (memory contents are private user notes).

import type { IncomingMessage, ServerResponse } from "node:http";
import type { MemoryProvider } from "../memory-store.js";
import type { RouteCtx } from "../http-utils.js";
import { safeDecode } from "../http-utils.js";
import type { MemorySyncService } from "../memory-sync-service.js";

export interface MemoryRouteDeps {
  memoryProvider: MemoryProvider;
  resolveCurrentOwnerId: () => string | null;
  memorySync: MemorySyncService;
}

export async function tryHandleMemoryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: RouteCtx,
  deps: MemoryRouteDeps,
): Promise<boolean> {
  const { sendJson, sendError, readJsonBody, rejectIfNonLocalOrigin } = ctx;
  const { memoryProvider } = deps;

  const memoriesPath = url.split("?")[0];

  // POST /api/memories/reconcile — manual / lifecycle-triggered sync pass.
  // Calls memorySync.reconcile(); returns { pulled, pushed, applied, status }.
  // No-op (free user / signed out / profile conflict) returns 200 + zero counts.
  if (req.method === "POST" && memoriesPath === "/api/memories/reconcile") {
    if (rejectIfNonLocalOrigin()) return true;
    try {
      const parsed = new URL(req.url ?? "/", "http://localhost");
      const reason = parsed.searchParams.get("reason") ?? "";
      const result = await deps.memorySync.reconcile();
      const status = result.pulled || result.pushed ? "synced" : "noop";
      if (status === "synced") {
        const tag = reason ? `manual reconcile (reason=${reason})` : "manual reconcile";
        console.log(`[memory] ${tag}: pulled=${result.pulled} pushed=${result.pushed}`);
      }
      sendJson({ ...result, applied: result.pulled, status });
    } catch (err) {
      sendError(err);
    }
    return true;
  }

  // DELETE /api/memories/:id — soft-delete (mark forgotten). Mirrors the MCP
  // `forget` tool. 404 if the id doesn't exist so the UI can distinguish
  // missing rows from server errors.
  if (req.method === "DELETE" && memoriesPath.startsWith("/api/memories/")) {
    if (rejectIfNonLocalOrigin()) return true;
    const id = safeDecode(memoriesPath.slice("/api/memories/".length));
    if (id === null) {
      sendJson({ error: "malformed id encoding" }, 400);
      return true;
    }
    if (!id) {
      sendJson({ error: "id is required" }, 400);
      return true;
    }
    try {
      const removed = await memoryProvider.forget(id, deps.resolveCurrentOwnerId());
      if (!removed) {
        sendJson({ error: "memory not found" }, 404);
        return true;
      }
      // SSE broadcast is fired via the provider's onWrite hook in index.ts —
      // no need to emit here too (would cause a duplicate refetch).
      res.statusCode = 204;
      res.end();
    } catch (err) {
      sendError(err);
    }
    return true;
  }

  // GET /api/memories/search?q=…&space_id=…&limit=…
  // FTS5 search over memories. Side-effect-free (does NOT update
  // access counts or write memory_recalls). Local-origin only.
  if (req.method === "GET" && memoriesPath === "/api/memories/search") {
    if (rejectIfNonLocalOrigin()) return true;
    const parsed = new URL(req.url ?? "/", "http://localhost");
    const q = parsed.searchParams.get("q") ?? "";
    const spaceId = parsed.searchParams.get("space_id");
    const limitRaw = parsed.searchParams.get("limit");
    let limit: number | undefined;
    if (limitRaw !== null) {
      const n = Number(limitRaw);
      if (Number.isFinite(n) && n >= 1) limit = Math.min(50, Math.floor(n));
    }
    try {
      const hits = await memoryProvider.search({
        query: q,
        space_id: spaceId ?? undefined,
        limit,
      });
      sendJson(hits);
    } catch (err) {
      sendError(err);
    }
    return true;
  }

  // GET /api/memories — list memories, optionally scoped to a space.
  // Strip the query string before path-matching (same trap the events
  // route had — `$`-anchored regex would silently reject `?space_id=…`).
  if (memoriesPath !== "/api/memories") return false;

  if (req.method === "GET") {
    if (rejectIfNonLocalOrigin()) return true;
    const parsed = new URL(req.url ?? "/", "http://localhost");
    const spaceId = parsed.searchParams.get("space_id");
    try {
      const memories = await memoryProvider.list(spaceId ?? undefined);
      sendJson(memories);
    } catch (err) {
      sendError(err, 500);
    }
    return true;
  }

  // POST /api/memories — user-authored memory. Mirrors the MCP `remember`
  // tool: empty content rejected, exact-content dedupe, space optional.
  if (req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return true;
    try {
      const body = await readJsonBody();
      const content = typeof body.content === "string" ? body.content.trim() : "";
      if (!content) {
        sendJson({ error: "content is required" }, 400);
        return true;
      }
      const space_id = typeof body.space_id === "string" && body.space_id ? body.space_id : undefined;
      const tags = Array.isArray(body.tags)
        ? body.tags.filter((t): t is string => typeof t === "string" && t.length > 0)
        : undefined;
      const memory = await memoryProvider.remember({
        content, space_id, tags,
        cloud_owner_id: deps.resolveCurrentOwnerId(),
      });
      sendJson(memory, 201);
    } catch (err) {
      sendError(err);
    }
    return true;
  }

  return false;
}
