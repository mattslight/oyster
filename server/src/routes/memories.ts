// /api/memories — extracted from index.ts. Two endpoints, both
// local-origin only (memory contents are private user notes).

import type { IncomingMessage, ServerResponse } from "node:http";
import type { MemoryProvider } from "../memory-store.js";
import type { RouteCtx } from "../http-utils.js";
import { safeDecode } from "../http-utils.js";
import type { UiCommand } from "../../../shared/types.js";

export interface MemoryRouteDeps {
  memoryProvider: MemoryProvider;
  broadcastUiEvent: (event: UiCommand) => void;
}

export async function tryHandleMemoryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: RouteCtx,
  deps: MemoryRouteDeps,
): Promise<boolean> {
  const { sendJson, sendError, readJsonBody, rejectIfNonLocalOrigin } = ctx;
  const { memoryProvider, broadcastUiEvent } = deps;

  const memoriesPath = url.split("?")[0];

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
      const removed = await memoryProvider.forget(id);
      if (!removed) {
        sendJson({ error: "memory not found" }, 404);
        return true;
      }
      broadcastUiEvent({ version: 1, command: "memory_changed", payload: { id, op: "forget" } });
      res.statusCode = 204;
      res.end();
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
      const memory = await memoryProvider.remember({ content, space_id, tags });
      sendJson(memory, 201);
    } catch (err) {
      sendError(err);
    }
    return true;
  }

  return false;
}
