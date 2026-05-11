import { jsonOk, jsonError } from "./json.js";
import type { Env } from "./session.js";
import { resolveSession } from "./session.js";
import { encryptForUser, decryptForUser } from "./encryption.js";

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

    if (url.pathname === "/api/sessions/metadata" && req.method === "POST") {
      return handleSessionsMetadataPost(req, env);
    }

    if (url.pathname === "/api/sessions/metadata" && req.method === "GET") {
      return handleSessionsMetadataGet(req, env);
    }

    const bytesMatch = url.pathname.match(/^\/api\/sessions\/bytes\/([^/]+)$/);
    if (bytesMatch && bytesMatch[1]) {
      // decodeURIComponent throws URIError on malformed percent-encoding
      // (e.g. "%G"). Without this guard, a bad path would surface as an
      // unhandled rejection instead of a structured 4xx.
      let sessionId: string;
      try { sessionId = decodeURIComponent(bytesMatch[1]); }
      catch { return jsonError(400, "invalid_session_id"); }
      if (req.method === "PUT") return handleSessionsBytesPut(req, env, sessionId);
      if (req.method === "GET") return handleSessionsBytesGet(req, env, sessionId);
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

  // Defensive cap. The local sync service batches at 100 events; even
  // aggressive backfills shouldn't exceed this.
  const MAX_EVENTS_PER_REQUEST = 1000;
  if (incoming.length > MAX_EVENTS_PER_REQUEST) {
    return jsonError(413, "too_many_events");
  }

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

      const eventStmt = env.DB.prepare(
        `INSERT OR IGNORE INTO synced_memory_events
           (owner_id, event_id, memory_id, event_type, space_id, created_at, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(user.id, ev.event_id, ev.memory_id, ev.event_type, ev.space_id, ev.created_at, now);

      let payloadStmt: ReturnType<typeof env.DB.prepare> | null = null;
      if (ev.event_type === "memory_purged") {
        payloadStmt = env.DB.prepare(
          // Guard on event_id presence so a per-type uniqueness conflict
          // (different event_id, same memory_id+purged) is a no-op for the
          // payload. The event INSERT runs first in the batch; if it was
          // ignored, the EXISTS check fails and nothing is written.
          `INSERT INTO synced_memory_payloads (owner_id, memory_id, content, tags, purged_at)
             SELECT ?, ?, NULL, '[]', ?
              WHERE EXISTS (SELECT 1 FROM synced_memory_events
                             WHERE owner_id = ? AND event_id = ?)
           ON CONFLICT(owner_id, memory_id) DO UPDATE SET
             content   = NULL,
             tags      = '[]',
             purged_at = excluded.purged_at`,
        ).bind(user.id, ev.memory_id, ev.created_at, user.id, ev.event_id);
      } else if (ev.event_type === "memory_created" && ev.payload) {
        // Idempotent payload upsert that respects an earlier purge.
        // If a purge exists for this memory_id (in cloud), content stays NULL.
        payloadStmt = env.DB.prepare(
          // Guards: (1) the event INSERT actually landed for this event_id (so
          // per-type uniqueness conflicts skip the payload), AND (2) no purge
          // exists for this memory_id (so prior purges are not undone).
          `INSERT INTO synced_memory_payloads (owner_id, memory_id, content, tags, purged_at)
             SELECT ?, ?, ?, ?, NULL
              WHERE EXISTS (SELECT 1 FROM synced_memory_events
                             WHERE owner_id = ? AND event_id = ?)
                AND NOT EXISTS (
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
          user.id, ev.event_id,
          user.id, ev.memory_id,
        );
      }

      // Atomic: event INSERT + payload upsert run as one D1 transaction. The
      // payload SQL guards on event_id presence, so per-type uniqueness
      // conflicts naturally skip the payload write. Duplicates (same event_id
      // already exists) heal the payload via the EXISTS guard matching the
      // pre-existing event row. Newly-inserted events get their payload set.
      const stmts = payloadStmt ? [eventStmt, payloadStmt] : [eventStmt];
      const results = await env.DB.batch(stmts);
      // results[0] is always present — batch never returns an empty array here.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const eventChanges = results[0]!.meta.changes;

      if (eventChanges > 0) {
        accepted.push(ev.event_id);
        continue;
      }

      // Event INSERT was a no-op. Distinguish duplicate from conflict.
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

// ── Session sync (#322) ──────────────────────────────────────────────

interface IncomingSession {
  id: string;
  device_id?: string | null;
  agent: string;
  title: string | null;
  state: string;
  cwd: string | null;
  model: string | null;
  started_at: string;
  ended_at: string | null;
  last_event_at: string;
  // Local sync_dirty_at acts as the LWW tiebreaker on the wire — newer
  // wins on conflicts so a Device-A push during a Device-B-stale window
  // doesn't get clobbered.
  sync_dirty_at: number;
}

function isValidSession(s: unknown): s is IncomingSession {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.length === 0) return false;
  if (typeof o.agent !== "string" || o.agent.length === 0) return false;
  if (typeof o.state !== "string" || o.state.length === 0) return false;
  if (typeof o.started_at !== "string") return false;
  if (typeof o.last_event_at !== "string") return false;
  if (typeof o.sync_dirty_at !== "number" || !Number.isFinite(o.sync_dirty_at)) return false;
  if (o.sync_dirty_at < 0) return false;
  // Nullable fields must be string-or-null. Anything else (number, object,
  // array) would either crash D1 .bind() with TypeError or silently coerce
  // to a useless string representation. Each malformed session is rejected
  // individually so the rest of the batch still lands.
  for (const key of ["title", "cwd", "model", "ended_at", "device_id"] as const) {
    const v = o[key];
    if (v !== null && v !== undefined && typeof v !== "string") return false;
  }
  return true;
}

async function handleSessionsMetadataPost(req: Request, env: Env): Promise<Response> {
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");
  if (user.tier !== "pro") return jsonError(403, "pro_required");

  let body: { sessions?: unknown };
  try { body = await req.json() as { sessions?: unknown }; }
  catch { return jsonError(400, "invalid_metadata"); }

  const incoming = body.sessions;
  if (!Array.isArray(incoming)) return jsonError(400, "invalid_metadata");

  const MAX_SESSIONS_PER_REQUEST = 1000;
  if (incoming.length > MAX_SESSIONS_PER_REQUEST) {
    return jsonError(413, "too_many_sessions");
  }

  const accepted: string[] = [];
  const rejected: string[] = [];

  try {
    for (const raw of incoming) {
      if (!isValidSession(raw)) {
        const id = (raw as { id?: unknown })?.id;
        rejected.push(typeof id === "string" && id.length > 0 ? id : "<malformed>");
        continue;
      }
      const s = raw;
      // LWW: only overwrite an existing row when the incoming sync_dirty_at
      // is strictly greater than what's stored. New rows always insert.
      // Using INSERT … ON CONFLICT DO UPDATE WHERE keeps it one statement.
      const result = await env.DB.prepare(
        `INSERT INTO synced_session_metadata
           (owner_id, session_id, device_id, agent, title, state, cwd, model,
            started_at, ended_at, last_event_at, jsonl_r2_key, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(owner_id, session_id) DO UPDATE SET
           device_id     = excluded.device_id,
           agent         = excluded.agent,
           title         = excluded.title,
           state         = excluded.state,
           cwd           = excluded.cwd,
           model         = excluded.model,
           started_at    = excluded.started_at,
           ended_at      = excluded.ended_at,
           last_event_at = excluded.last_event_at,
           updated_at    = excluded.updated_at
          WHERE excluded.updated_at > synced_session_metadata.updated_at`,
      ).bind(
        user.id, s.id, s.device_id ?? null, s.agent, s.title, s.state, s.cwd, s.model,
        s.started_at, s.ended_at, s.last_event_at, s.sync_dirty_at,
      ).run();
      // changes > 0 means a row was inserted or LWW won an update. changes 0
      // means an older sync_dirty_at lost the LWW race; still acknowledge so
      // the client clears its dirty flag — cloud has a newer version.
      accepted.push(s.id);
      // touch result so the linter is satisfied
      void result;
    }
  } catch (err) {
    console.warn("[sessions] metadata ingest db error:", err);
    return jsonError(500, "db_error");
  }

  return jsonOk({ accepted, rejected });
}

async function handleSessionsMetadataGet(req: Request, env: Env): Promise<Response> {
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");
  if (user.tier !== "pro") return jsonError(403, "pro_required");

  type Row = {
    session_id: string; device_id: string | null; agent: string; title: string | null;
    state: string; cwd: string | null; model: string | null; started_at: string;
    ended_at: string | null; last_event_at: string; jsonl_r2_key: string | null;
    updated_at: number;
  };
  const { results } = await env.DB.prepare(
    `SELECT session_id, device_id, agent, title, state, cwd, model, started_at,
            ended_at, last_event_at, jsonl_r2_key, updated_at
       FROM synced_session_metadata
      WHERE owner_id = ?
      ORDER BY last_event_at DESC`,
  ).bind(user.id).all<Row>();

  return jsonOk({ sessions: results ?? [] }, 200, { "cache-control": "private, no-store" });
}

function r2KeyFor(ownerId: string, sessionId: string): string {
  // No device_id in the key — sessions have a single canonical jsonl per
  // owner+session. Snapshot updates from the originating device overwrite.
  return `sessions/${ownerId}/${sessionId}.jsonl`;
}

// Hard cap on jsonl uploads. Real Claude Code sessions are typically 1-50 MB;
// 50 MB covers extreme edge cases without letting an abusive client fill R2
// or burn worker CPU. Workers' default body limit (100 MB) and CPU budget
// would catch this anyway, but we want a structured 413 instead of a runtime
// crash and the limit is small enough to keep encryption fast.
const MAX_BYTES_UPLOAD = 50 * 1024 * 1024;

async function handleSessionsBytesPut(req: Request, env: Env, sessionId: string): Promise<Response> {
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");
  if (user.tier !== "pro") return jsonError(403, "pro_required");

  // Confirm the session belongs to the caller before accepting bytes. Without
  // this check, a Pro user could arbitrarily overwrite any session id in
  // their own R2 prefix — harmless but wasteful and confusing in audit logs.
  const owns = await env.DB.prepare(
    `SELECT 1 FROM synced_session_metadata WHERE owner_id = ? AND session_id = ? LIMIT 1`,
  ).bind(user.id, sessionId).first();
  if (!owns) return jsonError(404, "session_not_found");

  // Fail fast on Content-Length when the client honestly declares it. Saves
  // reading 50+ MB into memory only to reject. Content-Length can be missing
  // or lie (chunked transfer, untrusted client) so we re-check after read.
  const lenHeader = req.headers.get("content-length");
  if (lenHeader) {
    const declared = Number(lenHeader);
    if (Number.isFinite(declared) && declared > MAX_BYTES_UPLOAD) {
      return jsonError(413, "payload_too_large");
    }
  }

  const plaintext = new Uint8Array(await req.arrayBuffer());
  if (plaintext.byteLength === 0) return jsonError(400, "empty_body");
  if (plaintext.byteLength > MAX_BYTES_UPLOAD) return jsonError(413, "payload_too_large");

  let ciphertext: Uint8Array;
  try {
    ciphertext = await encryptForUser(env.SESSIONS_ENCRYPTION_KEY, user.id, plaintext);
  } catch (err) {
    console.warn("[sessions] encrypt failed:", err);
    return jsonError(500, "encrypt_failed");
  }

  const key = r2KeyFor(user.id, sessionId);
  try {
    await env.SESSIONS_BUCKET.put(key, ciphertext, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { ownerId: user.id, sessionId, plaintextSize: String(plaintext.byteLength) },
    });
  } catch (err) {
    console.warn("[sessions] R2 put failed:", err);
    return jsonError(500, "r2_put_failed");
  }

  // Record the R2 key on the metadata row so cross-device clients know bytes
  // are available for lazy pull. Deliberately NOT touching updated_at: that
  // column is the LWW tiebreaker for metadata pushes (driven by the client's
  // sync_dirty_at). Bumping it here would be a wallclock value the client
  // can't beat, causing legitimate later metadata pushes with sync_dirty_at
  // > the previous metadata but < the bytes-PUT wallclock to be dropped.
  await env.DB.prepare(
    `UPDATE synced_session_metadata SET jsonl_r2_key = ?
      WHERE owner_id = ? AND session_id = ?`,
  ).bind(key, user.id, sessionId).run();

  return jsonOk({ ok: true, key, plaintextSize: plaintext.byteLength, ciphertextSize: ciphertext.byteLength });
}

async function handleSessionsBytesGet(req: Request, env: Env, sessionId: string): Promise<Response> {
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");
  if (user.tier !== "pro") return jsonError(403, "pro_required");

  // Owner check: refuse if the session isn't in this owner's metadata. Stops
  // any ""guess another user's session_id"" cross-account read attempt before
  // we even hit R2.
  const owns = await env.DB.prepare(
    `SELECT jsonl_r2_key FROM synced_session_metadata WHERE owner_id = ? AND session_id = ? LIMIT 1`,
  ).bind(user.id, sessionId).first<{ jsonl_r2_key: string | null }>();
  if (!owns) return jsonError(404, "session_not_found");
  if (!owns.jsonl_r2_key) return jsonError(404, "bytes_not_uploaded");

  const obj = await env.SESSIONS_BUCKET.get(owns.jsonl_r2_key);
  if (!obj) return jsonError(404, "bytes_missing");

  const ciphertext = new Uint8Array(await obj.arrayBuffer());
  let plaintext: Uint8Array;
  try {
    plaintext = await decryptForUser(env.SESSIONS_ENCRYPTION_KEY, user.id, ciphertext);
  } catch (err) {
    console.warn("[sessions] decrypt failed:", err);
    return jsonError(500, "decrypt_failed");
  }

  return new Response(plaintext, {
    status: 200,
    headers: {
      "content-type": "application/jsonl",
      "cache-control": "private, no-store",
    },
  });
}
