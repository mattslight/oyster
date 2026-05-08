import { jsonOk, jsonError } from "./json.js";
import type { Env } from "./session.js";
import { resolveSession } from "./session.js";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Routes for this worker land in Tasks 6 and 7. For now, anything
    // that isn't matched returns 404. Health-check responds 200 for
    // deployment smoke-tests.
    if (url.pathname === "/health" && req.method === "GET") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname === "/api/memories/events" && req.method === "POST") {
      return handleMemoryEventsPost(req, env);
    }

    if (url.pathname === "/api/memories/events" && req.method === "GET") {
      return handleMemoryEventsGet(req, env);
    }

    return jsonError(404, "not_found");
  },
};

async function handleMemoryEventsPost(req: Request, env: Env): Promise<Response> {
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");
  if (user.tier !== "pro") return jsonError(403, "pro_required");

  type IncomingEvent = {
    event_id: string;
    memory_id: string;
    event_type: "memory_created" | "memory_forgotten" | "memory_purged";
    space_id: string | null;
    created_at: number;
    payload?: { content: string; tags: string[] };
  };
  let body: { events?: IncomingEvent[] };
  try { body = await req.json() as typeof body; }
  catch { return jsonError(400, "invalid_metadata"); }

  const incoming = body.events ?? [];
  if (!Array.isArray(incoming)) return jsonError(400, "invalid_metadata");

  const accepted:   string[] = [];
  const duplicates: string[] = [];
  const conflicts:  string[] = [];
  const rejected:   string[] = [];

  // Validate each event up-front. Rejected events are NOT marked synced by
  // the client — they surface as warnings.
  function isValidEvent(ev: unknown): ev is IncomingEvent {
    if (!ev || typeof ev !== "object") return false;
    const e = ev as Record<string, unknown>;
    if (typeof e.event_id !== "string" || e.event_id.length === 0) return false;
    if (typeof e.memory_id !== "string" || e.memory_id.length === 0) return false;
    if (e.event_type !== "memory_created" && e.event_type !== "memory_forgotten" && e.event_type !== "memory_purged") return false;
    if (typeof e.created_at !== "number" || !Number.isFinite(e.created_at) || e.created_at < 0) return false;
    if (e.space_id !== null && typeof e.space_id !== "string") return false;
    if (e.event_type === "memory_created" && e.payload !== undefined) {
      const p = e.payload as Record<string, unknown>;
      if (!p || typeof p !== "object") return false;
      if (typeof p.content !== "string") return false;
      if (!Array.isArray(p.tags) || !p.tags.every((t) => typeof t === "string")) return false;
    }
    return true;
  }

  const valid: IncomingEvent[] = [];
  for (const raw of incoming) {
    if (!isValidEvent(raw)) {
      const id = (raw as { event_id?: unknown })?.event_id;
      rejected.push(typeof id === "string" && id.length > 0 ? id : "<malformed>");
      continue;
    }
    valid.push(raw);
  }

  // Precedence-first ordering: purges, then forgets, then creates. Within each
  // bucket, sort by created_at ascending. This ensures a `memory_created`
  // event whose payload was nulled locally before sync (purge-arrives-second
  // from the client) lands AFTER any same-batch purge has been recorded, so
  // the payload-upsert query naturally suppresses the content.
  const PRECEDENCE: Record<IncomingEvent["event_type"], number> = {
    memory_purged: 0, memory_forgotten: 1, memory_created: 2,
  };
  valid.sort((a, b) => PRECEDENCE[a.event_type] - PRECEDENCE[b.event_type] || a.created_at - b.created_at);

  // Track which memory_ids have a purge in this batch — combined with the
  // existing-purge check in DB, used to validate empty-payload creates.
  const purgedInBatch = new Set<string>();
  for (const ev of valid) if (ev.event_type === "memory_purged") purgedInBatch.add(ev.memory_id);

  const now = Date.now();
  try {
    for (const ev of valid) {
      // Reject memory_created without payload UNLESS a purge already exists
      // for this memory_id (in cloud OR earlier in this batch). Otherwise an
      // empty-payload create would land an unrecoverable empty memory.
      if (ev.event_type === "memory_created" && !ev.payload) {
        const existingPurge = await env.DB.prepare(
          `SELECT 1 FROM synced_memory_events
            WHERE owner_id = ? AND memory_id = ? AND event_type = 'memory_purged' LIMIT 1`,
        ).bind(user.id, ev.memory_id).first();
        if (!existingPurge && !purgedInBatch.has(ev.memory_id)) {
          rejected.push(ev.event_id);
          continue;
        }
      }

      // Build the event-insert + payload statement atomically via env.DB.batch.
      // Each event's pair runs as one D1 transaction — no half-applied state.
      const eventStmt = env.DB.prepare(
        `INSERT OR IGNORE INTO synced_memory_events
           (owner_id, event_id, memory_id, event_type, space_id, created_at, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(user.id, ev.event_id, ev.memory_id, ev.event_type, ev.space_id, ev.created_at, now);

      let payloadStmt: ReturnType<typeof env.DB.prepare> | null = null;
      if (ev.event_type === "memory_purged") {
        payloadStmt = env.DB.prepare(
          `INSERT INTO synced_memory_payloads (owner_id, memory_id, content, tags, purged_at)
           VALUES (?, ?, NULL, '[]', ?)
           ON CONFLICT(owner_id, memory_id) DO UPDATE SET
             content   = NULL,
             tags      = '[]',
             purged_at = excluded.purged_at`,
        ).bind(user.id, ev.memory_id, ev.created_at);
      } else if (ev.event_type === "memory_created" && ev.payload) {
        // Idempotent payload upsert that respects an earlier purge.
        // If a purge exists for this memory_id (in cloud), content stays NULL.
        payloadStmt = env.DB.prepare(
          `INSERT INTO synced_memory_payloads (owner_id, memory_id, content, tags, purged_at)
             SELECT ?, ?, ?, ?, NULL
              WHERE NOT EXISTS (
                SELECT 1 FROM synced_memory_events
                 WHERE owner_id = ? AND memory_id = ? AND event_type = 'memory_purged'
              )
           ON CONFLICT(owner_id, memory_id) DO UPDATE SET
             content = CASE
               WHEN EXISTS (SELECT 1 FROM synced_memory_events
                              WHERE owner_id = synced_memory_payloads.owner_id
                                AND memory_id = synced_memory_payloads.memory_id
                                AND event_type = 'memory_purged')
                 THEN NULL
               ELSE excluded.content
             END,
             tags = CASE
               WHEN EXISTS (SELECT 1 FROM synced_memory_events
                              WHERE owner_id = synced_memory_payloads.owner_id
                                AND memory_id = synced_memory_payloads.memory_id
                                AND event_type = 'memory_purged')
                 THEN '[]'
               ELSE excluded.tags
             END`,
        ).bind(
          user.id, ev.memory_id, ev.payload.content, JSON.stringify(ev.payload.tags),
          user.id, ev.memory_id,
        );
      }

      const stmts = payloadStmt ? [eventStmt, payloadStmt] : [eventStmt];
      const results = await env.DB.batch(stmts);
      const eventChanges = results[0].meta.changes;

      if (eventChanges > 0) {
        accepted.push(ev.event_id);
        continue;
      }

      // Event INSERT was a no-op. Distinguish duplicate event_id from per-type
      // uniqueness conflict. The PK is (owner_id, event_id); per-type partial
      // unique indexes cover (owner_id, memory_id, event_type) WHERE the type
      // matches. Both are safely idempotent — caller marks them synced.
      const dup = await env.DB.prepare(
        `SELECT 1 FROM synced_memory_events WHERE owner_id = ? AND event_id = ? LIMIT 1`,
      ).bind(user.id, ev.event_id).first();
      if (dup) duplicates.push(ev.event_id);
      else conflicts.push(ev.event_id);
    }
  } catch (err) {
    console.warn("[memory] events ingest db error:", err);
    return jsonError(500, "db_error");
  }

  return jsonOk({ accepted, duplicates, conflicts, rejected });
}

async function handleMemoryEventsGet(req: Request, env: Env): Promise<Response> {
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");
  if (user.tier !== "pro") return jsonError(403, "pro_required");

  type EventRow = {
    event_id: string; memory_id: string; event_type: string;
    space_id: string | null; created_at: number;
    p_content: string | null; p_tags: string | null; p_purged_at: number | null;
  };
  const { results } = await env.DB.prepare(
    `SELECT e.event_id, e.memory_id, e.event_type, e.space_id, e.created_at,
            p.content   AS p_content,
            p.tags      AS p_tags,
            p.purged_at AS p_purged_at
       FROM synced_memory_events e
       LEFT JOIN synced_memory_payloads p
         ON p.owner_id = e.owner_id AND p.memory_id = e.memory_id
      WHERE e.owner_id = ?
      ORDER BY e.created_at ASC`,
  ).bind(user.id).all<EventRow>();

  const events = (results ?? []).map((r) => {
    const base = {
      event_id: r.event_id,
      memory_id: r.memory_id,
      event_type: r.event_type,
      space_id: r.space_id,
      created_at: r.created_at,
    };
    if (r.event_type === "memory_created") {
      return {
        ...base,
        payload: {
          content: r.p_content,
          tags: r.p_tags ? JSON.parse(r.p_tags) : [],
          purged_at: r.p_purged_at,
        },
      };
    }
    return base;
  });

  return jsonOk({ events }, 200, { "cache-control": "private, no-store" });
}
