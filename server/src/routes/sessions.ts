// /api/sessions/* route bucket — extracted from index.ts.
//
// Returns true when a request was handled; the caller (index.ts) keeps
// dispatching to other route modules / inline handlers when this returns
// false. Same semantics as the if-block sequence it replaces — no
// behavioural changes, only refactored shape.

import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import type { SessionStore } from "../session-store.js";
import type { SqliteSpaceStore } from "../space-store.js";
import type { ArtifactService } from "../artifact-service.js";
import type { MemoryProvider } from "../memory-store.js";
import type { RouteCtx } from "../http-utils.js";

export interface SessionRouteDeps {
  sessionStore: SessionStore;
  spaceStore: SqliteSpaceStore;
  artifactService: ArtifactService;
  memoryProvider: MemoryProvider;
}

export async function tryHandleSessionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: RouteCtx,
  deps: SessionRouteDeps,
): Promise<boolean> {
  const { sendJson, sendError, rejectIfNonLocalOrigin } = ctx;
  const { sessionStore, spaceStore, artifactService, memoryProvider } = deps;

  // GET /api/sessions — agent sessions captured by the watchers (#251).
  // Read-only for 0.5.0; the home feed renders these. Local-origin only —
  // session titles are derived from user prompts, which are private.
  if (url === "/api/sessions" && req.method === "GET") {
    if (rejectIfNonLocalOrigin()) return true;
    const rows = sessionStore.getAll();
    // Join sources for sourceLabel — batched IN-list queries so the
    // home feed can show "active project" tiles without a per-tile
    // round trip. Sources are dedup'd because most sessions cluster
    // around a small number of registered folders. Chunked at 500
    // ids per batch to stay well below SQLite's 999-bound-variable
    // ceiling on installs that haven't been recompiled with the
    // higher 32_766 limit.
    const sourceIds = [...new Set(rows.map((r) => r.source_id).filter((id): id is string => !!id))];
    const SOURCE_BATCH = 500;
    const sourceList = [];
    for (let i = 0; i < sourceIds.length; i += SOURCE_BATCH) {
      sourceList.push(...spaceStore.getSourcesByIds(sourceIds.slice(i, i + SOURCE_BATCH)));
    }
    const sourcesById = new Map(sourceList.map((s) => [s.id, s]));
    sendJson(rows.map((row) => {
      const src = row.source_id ? sourcesById.get(row.source_id) : null;
      const label = src ? (src.label ?? (basename(src.path) || null)) : null;
      return {
        id: row.id,
        spaceId: row.space_id,
        sourceId: row.source_id ?? null,
        sourceLabel: label,
        cwd: row.cwd,
        agent: row.agent,
        title: row.title,
        state: row.state,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        model: row.model,
        lastEventAt: row.last_event_at,
      };
    }));
    return true;
  }

  // GET /api/sessions/search?q=…&session_id=…&limit=…
  // R2 verbatim recall (#311). FTS5 over session_events.text. Mirrors the
  // MCP `recall_transcripts` tool surface for the web UI.
  // Local-origin only — transcripts are private user content.
  {
    const searchPath = url.split("?")[0];
    if (searchPath === "/api/sessions/search" && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return true;
      const parsed = new URL(req.url ?? "/", "http://localhost");
      const q = parsed.searchParams.get("q") ?? "";
      const scopeSession = parsed.searchParams.get("session_id") ?? undefined;
      const limitRaw = parsed.searchParams.get("limit");
      // Validate before clamping — Number("foo") is NaN, which Math.min/max
      // propagate. Treat anything non-finite or non-positive as "use the
      // store's default" rather than 400'ing.
      let limit: number | undefined;
      if (limitRaw !== null) {
        const parsedLimit = Number(limitRaw);
        if (Number.isFinite(parsedLimit) && parsedLimit >= 1) {
          limit = Math.min(50, Math.floor(parsedLimit));
        }
      }
      try {
        const hits = sessionStore.searchEvents(q, { sessionId: scopeSession, limit });
        // Rename `id` → `event_id` for the wire format (the web UI's
        // ambient `id` is artefact id; explicit naming avoids confusion).
        sendJson(hits.map((h) => ({
          event_id: h.id,
          session_id: h.session_id,
          session_title: h.session_title,
          role: h.role,
          ts: h.ts,
          snippet: h.snippet,
        })));
      } catch (err) {
        sendError(err, 500);
      }
      return true;
    }
  }

  // GET /api/sessions/:id — single session row (or 404)
  {
    const m = url.match(/^\/api\/sessions\/([^/]+)$/);
    if (m && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return true;
      const row = sessionStore.getById(m[1]);
      if (!row) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "session not found" }));
        return true;
      }
      const src = row.source_id ? spaceStore.getSourceById(row.source_id) : undefined;
      const sourceLabel = src ? (src.label ?? (basename(src.path) || null)) : null;
      sendJson({
        id: row.id,
        spaceId: row.space_id,
        sourceId: row.source_id ?? null,
        sourceLabel,
        cwd: row.cwd,
        agent: row.agent,
        title: row.title,
        state: row.state,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        model: row.model,
        lastEventAt: row.last_event_at,
      });
      return true;
    }
  }

  // GET /api/sessions/:id/events — transcript events (oldest first within
  // the returned slice). The `raw` JSONL line is dropped because long
  // sessions can ship 50+MB of raw blobs; clients lazy-fetch raw via
  // /events/:eventId when they expand a tool turn.
  //
  // Cursors:
  //   ?before=<id> — events with id < before, latest N (load older on scroll up)
  //   ?after=<id>  — events with id > after, oldest N (live append)
  //   neither     — latest N (bootstrap)
  // ?limit=N defaults to 1000.
  {
    // Strip the query string before path matching — the `$` anchor in the
    // regex would otherwise reject any URL with `?...`. Pre-existing bug:
    // `?limit=N` was always silently ignored before this fix.
    const eventsPath = url.split("?")[0];
    const m = eventsPath.match(/^\/api\/sessions\/([^/]+)\/events$/);
    if (m && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return true;
      const parsed = new URL(req.url ?? "/", "http://localhost");
      const limitParam = parsed.searchParams.get("limit");
      const limit = limitParam && Number.isFinite(Number(limitParam))
        ? Math.max(1, Math.min(10_000, Number(limitParam)))
        : 1000;
      const beforeParam = parsed.searchParams.get("before");
      const afterParam = parsed.searchParams.get("after");
      const aroundParam = parsed.searchParams.get("around");
      const before = beforeParam && Number.isFinite(Number(beforeParam))
        ? Number(beforeParam) : null;
      const after = afterParam && Number.isFinite(Number(afterParam))
        ? Number(afterParam) : null;
      const around = aroundParam && Number.isFinite(Number(aroundParam))
        ? Number(aroundParam) : null;
      let events;
      if (around !== null) {
        // Centred window: split the budget so the merged result is at
        // most `limit` events. The target is included in the "older"
        // half (id <= around), so olderLimit gets the ceil. Sort ASC
        // by id so the transcript renders chronologically regardless
        // of how the underlying statements ordered their result sets.
        const olderLimit = Math.max(1, Math.ceil(limit / 2));
        const newerLimit = Math.max(0, limit - olderLimit);
        const older = sessionStore.getEventsBeforeBySession(m[1], around + 1, olderLimit);
        const newer = newerLimit > 0
          ? sessionStore.getEventsAfterBySession(m[1], around, newerLimit)
          : [];
        events = [...older, ...newer].sort((a, b) => a.id - b.id);
      } else if (before !== null) {
        events = sessionStore.getEventsBeforeBySession(m[1], before, limit);
      } else if (after !== null) {
        events = sessionStore.getEventsAfterBySession(m[1], after, limit);
      } else {
        events = sessionStore.getEventsBySession(m[1], { limit });
      }
      sendJson(events.map((e) => ({
        id: e.id,
        sessionId: e.session_id,
        role: e.role,
        text: e.text,
        ts: e.ts,
        raw: null as string | null,
      })));
      return true;
    }
  }

  // GET /api/sessions/:id/events/:eventId — single event WITH raw JSONL.
  // Exists so the inspector can lazily load the raw blob for tool-call
  // expand without paying for it on every transcript fetch.
  {
    const m = url.match(/^\/api\/sessions\/([^/]+)\/events\/(\d+)$/);
    if (m && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return true;
      const eventId = Number(m[2]);
      const ev = sessionStore.getEventById(m[1], eventId);
      if (!ev) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "event not found" }));
        return true;
      }
      sendJson({
        id: ev.id,
        sessionId: ev.session_id,
        role: ev.role,
        text: ev.text,
        ts: ev.ts,
        raw: ev.raw,
      });
      return true;
    }
  }

  // GET /api/sessions/:id/artifacts — touched artefacts joined with artifact metadata
  {
    const m = url.match(/^\/api\/sessions\/([^/]+)\/artifacts$/);
    if (m && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return true;
      const touches = sessionStore.getArtifactsBySession(m[1]);
      const uniqueIds = Array.from(new Set(touches.map((t) => t.artifact_id)));
      const artifacts = await artifactService.getArtifactsByIds(uniqueIds);
      const byId = new Map(artifacts.map((a) => [a.id, a]));
      sendJson(touches.flatMap((t) => {
        const a = byId.get(t.artifact_id);
        if (!a) return [];
        return [{
          id: t.id,
          sessionId: t.session_id,
          artifactId: t.artifact_id,
          role: t.role,
          whenAt: t.when_at,
          artifact: a,
        }];
      }));
      return true;
    }
  }

  // GET /api/sessions/:id/memory — memories associated with this session.
  // R6 traceable recall (#310): returns {written, pulled} where written
  // are memories whose source_session_id == :id and pulled are memories
  // this session retrieved via recall(). Each memory has its source
  // session title resolved across the memory↔sessions DB boundary so
  // the UI can render "from <title>" without a second round trip.
  {
    const m = url.match(/^\/api\/sessions\/([^/]+)\/memory$/);
    if (m && req.method === "GET") {
      if (rejectIfNonLocalOrigin()) return true;
      try {
        const [written, pulled] = await Promise.all([
          memoryProvider.getBySourceSession(m[1]),
          memoryProvider.getRecalledBySession(m[1]),
        ]);
        // Resolve source_session_title for every memory we're about to
        // return. Batched: collect distinct session ids, fetch titles
        // once, then attach. memory.db and oyster.db are separate, so
        // this stitch happens at the API layer.
        const sourceIds = new Set<string>();
        for (const memory of [...written, ...pulled]) {
          if (memory.source_session_id) sourceIds.add(memory.source_session_id);
        }
        const titleById = new Map<string, string | null>();
        for (const sid of sourceIds) {
          titleById.set(sid, sessionStore.getById(sid)?.title ?? null);
        }
        const enrich = (memory: typeof written[number]) => ({
          ...memory,
          source_session_title: memory.source_session_id
            ? (titleById.get(memory.source_session_id) ?? null)
            : null,
        });
        sendJson({
          written: written.map(enrich),
          pulled: pulled.map(enrich),
        });
      } catch (err) {
        sendError(err, 500);
      }
      return true;
    }
  }

  return false;
}
