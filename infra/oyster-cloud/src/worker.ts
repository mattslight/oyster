import { jsonOk, jsonError } from "./json.js";
import type { Env } from "./session.js";
import { resolveSession } from "./session.js";
import { encryptChunk, decryptChunk, sha256Hex, type ChunkAad } from "./encryption.js";

// Safe decode helper used by all bytes routes. decodeURIComponent throws
// URIError on malformed percent-encoding (e.g. "%G"); we'd rather a 400 than
// an unhandled rejection.
function safeDecode(raw: string): string | null {
  try { return decodeURIComponent(raw); }
  catch { return null; }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

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

    // Session bytes — chunked-delta routes (#322). Four shapes:
    //   PUT  /api/sessions/bytes/:id/chunk/:n        upload one chunk
    //   GET  /api/sessions/bytes/:id/manifest        list chunks for current gen
    //   GET  /api/sessions/bytes/:id/chunk/:n        download one chunk
    //   POST /api/sessions/bytes/:id/reset           bump generation
    const chunkMatch = url.pathname.match(/^\/api\/sessions\/bytes\/([^/]+)\/chunk\/(\d+)$/);
    if (chunkMatch && chunkMatch[1] && chunkMatch[2]) {
      const sessionId = safeDecode(chunkMatch[1]);
      const chunkNumber = Number(chunkMatch[2]);
      if (sessionId === null) return jsonError(400, "invalid_session_id");
      if (!Number.isInteger(chunkNumber) || chunkNumber < 1) {
        return jsonError(400, "invalid_chunk_number");
      }
      if (req.method === "PUT") return handleSessionsBytesChunkPut(req, env, sessionId, chunkNumber);
      if (req.method === "GET") return handleSessionsBytesChunkGet(req, env, sessionId, chunkNumber);
    }

    const manifestMatch = url.pathname.match(/^\/api\/sessions\/bytes\/([^/]+)\/manifest$/);
    if (manifestMatch && manifestMatch[1] && req.method === "GET") {
      const sessionId = safeDecode(manifestMatch[1]);
      if (sessionId === null) return jsonError(400, "invalid_session_id");
      return handleSessionsBytesManifestGet(req, env, sessionId);
    }

    const resetMatch = url.pathname.match(/^\/api\/sessions\/bytes\/([^/]+)\/reset$/);
    if (resetMatch && resetMatch[1] && req.method === "POST") {
      const sessionId = safeDecode(resetMatch[1]);
      if (sessionId === null) return jsonError(400, "invalid_session_id");
      return handleSessionsBytesReset(req, env, sessionId);
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
  /** Human-readable origin device label (e.g. "MacBookPro"). Drives the
   *  cross-device chip in the UI. Sourced from device_identity.label on
   *  the pushing device. Capped at 64 chars to bound a malicious or buggy
   *  client's UX footprint. */
  device_label?: string | null;
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

/** Max length of an accepted device_label. Hostnames are RFC-bounded to 253
 *  but realistic labels are far shorter; cap at 64 to stop a buggy or
 *  malicious client from filling the UI chip with arbitrary text. */
const DEVICE_LABEL_MAX = 64;

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
  for (const key of ["title", "cwd", "model", "ended_at", "device_id", "device_label"] as const) {
    const v = o[key];
    if (v !== null && v !== undefined && typeof v !== "string") return false;
  }
  // device_label length cap — over-long values are silently truncated to
  // null rather than rejecting the whole session push. The pushing client
  // shouldn't send a 1KB label, but if it does we'd rather lose the chip
  // than lose the session.
  if (typeof o.device_label === "string" && o.device_label.length > DEVICE_LABEL_MAX) {
    o.device_label = null;
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
      // bytes_generation is owned by the chunked-bytes flow and never set
      // from metadata pushes — left at its existing value (default 0 on insert).
      const result = await env.DB.prepare(
        `INSERT INTO synced_session_metadata
           (owner_id, session_id, device_id, device_label, agent, title, state, cwd, model,
            started_at, ended_at, last_event_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_id, session_id) DO UPDATE SET
           device_id     = excluded.device_id,
           device_label  = COALESCE(excluded.device_label, synced_session_metadata.device_label),
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
      // D1 .bind() throws on undefined; the nullable fields are typed as
      // `string | null` in IncomingSession but the validator allows them to
      // be missing entirely. Coerce every nullable to null before binding so
      // a partial-shape session doesn't fail the whole batch with 500.
      ).bind(
        user.id, s.id, s.device_id ?? null, s.device_label ?? null, s.agent,
        s.title ?? null, s.state, s.cwd ?? null, s.model ?? null,
        s.started_at, s.ended_at ?? null, s.last_event_at, s.sync_dirty_at,
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

  // has_bytes is computed from EXISTS in chunks table at the current
  // generation. A session may have metadata but no chunks yet (push
  // hasn't fired) or chunks from older generations only (just reset).
  type Row = {
    session_id: string; device_id: string | null; device_label: string | null;
    agent: string; title: string | null;
    state: string; cwd: string | null; model: string | null; started_at: string;
    ended_at: string | null; last_event_at: string;
    bytes_generation: number; active_device_id: string | null;
    has_bytes: number; updated_at: number;
  };
  const { results } = await env.DB.prepare(
    `SELECT m.session_id, m.device_id, m.device_label, m.agent, m.title, m.state,
            m.cwd, m.model, m.started_at, m.ended_at, m.last_event_at,
            m.bytes_generation, m.active_device_id, m.updated_at,
            CASE WHEN EXISTS (
              SELECT 1 FROM synced_session_chunks c
               WHERE c.owner_id = m.owner_id
                 AND c.session_id = m.session_id
                 AND c.bytes_generation = m.bytes_generation
            ) THEN 1 ELSE 0 END AS has_bytes
       FROM synced_session_metadata m
      WHERE m.owner_id = ?
      ORDER BY m.last_event_at DESC`,
  ).bind(user.id).all<Row>();

  // Normalise has_bytes to boolean for the client.
  const sessions = (results ?? []).map((r) => ({ ...r, has_bytes: r.has_bytes === 1 }));
  return jsonOk({ sessions }, 200, { "cache-control": "private, no-store" });
}

// Per-chunk upload cap. Workers' default body limit is 100 MB; we stay well
// under that to leave headroom for encryption overhead + HTTP framing. There
// is no per-session total cap — chunks accumulate as the session grows.
const MAX_CHUNK_BYTES = 25 * 1024 * 1024;

function chunkR2Key(ownerId: string, sessionId: string, generation: number, chunkNumber: number): string {
  return `sessions/${ownerId}/${sessionId}/g${generation}/chunk-${chunkNumber}.bin`;
}

/** Look up the session's current generation. Returns null when the session
 *  isn't in the caller's metadata (cross-account / never-pushed). */
async function fetchCurrentGeneration(
  env: Env,
  ownerId: string,
  sessionId: string,
): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT bytes_generation FROM synced_session_metadata
      WHERE owner_id = ? AND session_id = ? LIMIT 1`,
  ).bind(ownerId, sessionId).first<{ bytes_generation: number }>();
  return row ? row.bytes_generation : null;
}

async function handleSessionsBytesChunkPut(
  req: Request,
  env: Env,
  sessionId: string,
  chunkNumber: number,
): Promise<Response> {
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");
  if (user.tier !== "pro") return jsonError(403, "pro_required");

  const currentGen = await fetchCurrentGeneration(env, user.id, sessionId);
  if (currentGen === null) return jsonError(404, "session_not_found");

  // Headers carry the metadata that gets bound into AAD. Each field must be
  // a number / string (validated below); the client's pushBytes always sets
  // these, so any missing header is a client bug or a tampered request.
  const startOffsetHeader = req.headers.get("x-chunk-start-offset");
  const endOffsetHeader = req.headers.get("x-chunk-end-offset");
  const plaintextSha256Header = req.headers.get("x-plaintext-sha256");
  const generationHeader = req.headers.get("x-bytes-generation");
  // x-bytes-device-id is optional for backwards-compat with clients pre-PR-2.x.
  // When present and well-formed, the worker bumps synced_session_metadata
  // .active_device_id on every accepted chunk so any reader can tell who's
  // currently writing. Clients generate it via crypto.randomUUID() (canonical
  // lowercase UUID), so we enforce that shape — anything else is silently
  // ignored to keep this back-compat (a malformed header doesn't fail the
  // chunk write, it just doesn't bump the column).
  const rawDeviceIdHeader = req.headers.get("x-bytes-device-id");
  const deviceIdHeader =
    rawDeviceIdHeader &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(rawDeviceIdHeader)
      ? rawDeviceIdHeader
      : null;

  if (!startOffsetHeader || !endOffsetHeader || !plaintextSha256Header || !generationHeader) {
    return jsonError(400, "missing_chunk_headers");
  }

  const startOffset = Number(startOffsetHeader);
  const endOffset = Number(endOffsetHeader);
  const generation = Number(generationHeader);

  if (!Number.isInteger(startOffset) || startOffset < 0) return jsonError(400, "invalid_start_offset");
  if (!Number.isInteger(endOffset) || endOffset <= startOffset) return jsonError(400, "invalid_end_offset");
  if (!Number.isInteger(generation) || generation < 0) return jsonError(400, "invalid_generation");
  if (!/^[0-9a-f]{64}$/.test(plaintextSha256Header)) return jsonError(400, "invalid_sha256");

  // Generation check. Client's local generation must match cloud's current.
  // Stale-generation PUTs from before a reset are rejected — they'd otherwise
  // pollute the manifest.
  if (generation !== currentGen) {
    return jsonError(409, "stale_generation");
  }

  // Read body + verify Content-Length against declared end-start. Fail fast
  // on declared sizes that exceed MAX_CHUNK_BYTES.
  const declaredSize = endOffset - startOffset;
  if (declaredSize > MAX_CHUNK_BYTES) return jsonError(413, "chunk_too_large");

  const lenHeader = req.headers.get("content-length");
  if (lenHeader) {
    const declared = Number(lenHeader);
    if (Number.isFinite(declared) && declared > MAX_CHUNK_BYTES) {
      return jsonError(413, "chunk_too_large");
    }
  }

  const plaintext = new Uint8Array(await req.arrayBuffer());
  if (plaintext.byteLength === 0) return jsonError(400, "empty_body");
  if (plaintext.byteLength > MAX_CHUNK_BYTES) return jsonError(413, "chunk_too_large");
  if (plaintext.byteLength !== declaredSize) return jsonError(400, "size_mismatch_with_offsets");

  // Verify the client's declared hash matches the actual body. Mismatch
  // means corruption in transit or a buggy/tampered client.
  const computedHash = await sha256Hex(plaintext);
  if (computedHash !== plaintextSha256Header) {
    return jsonError(400, "sha256_mismatch");
  }

  // Idempotency + contiguity checks. Look at any existing row for
  // (owner, session, generation, chunk_number) and at the prior chunk.
  const existing = await env.DB.prepare(
    `SELECT start_offset, end_offset, byte_count, plaintext_sha256
       FROM synced_session_chunks
      WHERE owner_id = ? AND session_id = ? AND bytes_generation = ? AND chunk_number = ?
      LIMIT 1`,
  ).bind(user.id, sessionId, generation, chunkNumber).first<{
    start_offset: number; end_offset: number; byte_count: number; plaintext_sha256: string;
  }>();
  if (existing) {
    // Idempotent retry path: all four immutable fields must match.
    if (
      existing.start_offset === startOffset &&
      existing.end_offset === endOffset &&
      existing.byte_count === declaredSize &&
      existing.plaintext_sha256 === plaintextSha256Header
    ) {
      return jsonOk({ ok: true, idempotent: true, chunk_number: chunkNumber, generation });
    }
    return jsonError(409, "chunk_conflict");
  }

  // Contiguity: this chunk's start_offset must equal the previous chunk's
  // end_offset (within the same generation). For chunk 1 the previous is
  // implicit-zero.
  if (chunkNumber === 1) {
    if (startOffset !== 0) return jsonError(409, "non_contiguous_start");
  } else {
    const prev = await env.DB.prepare(
      `SELECT end_offset FROM synced_session_chunks
        WHERE owner_id = ? AND session_id = ? AND bytes_generation = ? AND chunk_number = ?
        LIMIT 1`,
    ).bind(user.id, sessionId, generation, chunkNumber - 1).first<{ end_offset: number }>();
    if (!prev) return jsonError(409, "previous_chunk_missing");
    if (prev.end_offset !== startOffset) return jsonError(409, "non_contiguous_start");
  }

  // Encrypt with AAD-binding so the ciphertext can't be replayed as a
  // different chunk / session / generation.
  const aad: ChunkAad = {
    owner_id: user.id,
    session_id: sessionId,
    bytes_generation: generation,
    chunk_number: chunkNumber,
    start_offset: startOffset,
    end_offset: endOffset,
    plaintext_sha256: plaintextSha256Header,
  };
  let ciphertext: Uint8Array;
  try {
    ciphertext = await encryptChunk(env.SESSIONS_ENCRYPTION_KEY, aad, plaintext);
  } catch (err) {
    console.warn("[sessions] encryptChunk failed:", err);
    return jsonError(500, "encrypt_failed");
  }

  const r2Key = chunkR2Key(user.id, sessionId, generation, chunkNumber);
  try {
    await env.SESSIONS_BUCKET.put(r2Key, ciphertext, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        ownerId: user.id,
        sessionId,
        generation: String(generation),
        chunkNumber: String(chunkNumber),
        startOffset: String(startOffset),
        endOffset: String(endOffset),
        plaintextSha256: plaintextSha256Header,
        plaintextSize: String(plaintext.byteLength),
      },
    });
  } catch (err) {
    console.warn("[sessions] R2 put failed:", err);
    return jsonError(500, "r2_put_failed");
  }

  // Insert the chunk row. INSERT OR IGNORE is safe here because the
  // idempotency check above already returned 200 on exact-match retry.
  // A race between two clients pushing the same chunk would hit either
  // the existing-row path or this insert; either way the table is consistent.
  // Wrap in try/catch so a transient D1 hiccup surfaces as structured 500
  // rather than an unhandled exception.
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO synced_session_chunks
         (owner_id, session_id, bytes_generation, chunk_number,
          start_offset, end_offset, byte_count, plaintext_sha256, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      user.id, sessionId, generation, chunkNumber,
      startOffset, endOffset, declaredSize, plaintextSha256Header, Date.now(),
    ).run();
  } catch (err) {
    console.warn("[sessions] chunk insert db error:", err);
    return jsonError(500, "db_error");
  }

  // Bump active_device_id to whoever just wrote (#322 Pattern A). The
  // contiguity check above already enforces "you must be caught up to
  // write" — by the time we get here, this device is genuinely the
  // current writer. Header is optional for backwards-compat (pre-PR-2.x
  // clients won't send it); when absent we leave the column alone.
  if (deviceIdHeader) {
    try {
      await env.DB.prepare(
        `UPDATE synced_session_metadata
            SET active_device_id = ?
          WHERE owner_id = ? AND session_id = ?`,
      ).bind(deviceIdHeader, user.id, sessionId).run();
    } catch (err) {
      // Non-fatal — the chunk landed; the active_device_id bump is
      // informational. Log and continue.
      console.warn("[sessions] active_device_id update failed:", err);
    }
  }

  return jsonOk({
    ok: true,
    chunk_number: chunkNumber,
    generation,
    ciphertextSize: ciphertext.byteLength,
  });
}

async function handleSessionsBytesManifestGet(
  req: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");
  if (user.tier !== "pro") return jsonError(403, "pro_required");

  const meta = await env.DB.prepare(
    `SELECT bytes_generation, active_device_id
       FROM synced_session_metadata
      WHERE owner_id = ? AND session_id = ? LIMIT 1`,
  ).bind(user.id, sessionId).first<{ bytes_generation: number; active_device_id: string | null }>();
  if (!meta) return jsonError(404, "session_not_found");
  const currentGen = meta.bytes_generation;

  type Row = {
    chunk_number: number; start_offset: number; end_offset: number;
    byte_count: number; plaintext_sha256: string;
  };
  const { results } = await env.DB.prepare(
    `SELECT chunk_number, start_offset, end_offset, byte_count, plaintext_sha256
       FROM synced_session_chunks
      WHERE owner_id = ? AND session_id = ? AND bytes_generation = ?
      ORDER BY chunk_number ASC`,
  ).bind(user.id, sessionId, currentGen).all<Row>();

  const chunks = results ?? [];
  const totalSize = chunks.length > 0 ? chunks[chunks.length - 1]!.end_offset : 0;
  return jsonOk(
    {
      bytes_generation: currentGen,
      total_size: totalSize,
      // active_device_id is the device that most recently wrote a chunk. NULL
      // for sessions that pre-date the active_device tracking. Used by the
      // client to surface "Session is active on <device>" and to decide
      // whether resume should claim ownership.
      active_device_id: meta.active_device_id,
      chunks,
    },
    200,
    { "cache-control": "private, no-store" },
  );
}

async function handleSessionsBytesChunkGet(
  req: Request,
  env: Env,
  sessionId: string,
  chunkNumber: number,
): Promise<Response> {
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");
  if (user.tier !== "pro") return jsonError(403, "pro_required");

  // Optional ?gen=N selects a specific generation (for diagnostic / future
  // historical access). Defaults to current.
  const url = new URL(req.url);
  const genParam = url.searchParams.get("gen");
  let generation: number;
  if (genParam !== null) {
    generation = Number(genParam);
    if (!Number.isInteger(generation) || generation < 0) {
      return jsonError(400, "invalid_generation");
    }
  } else {
    const currentGen = await fetchCurrentGeneration(env, user.id, sessionId);
    if (currentGen === null) return jsonError(404, "session_not_found");
    generation = currentGen;
  }

  const row = await env.DB.prepare(
    `SELECT start_offset, end_offset, byte_count, plaintext_sha256
       FROM synced_session_chunks
      WHERE owner_id = ? AND session_id = ? AND bytes_generation = ? AND chunk_number = ?
      LIMIT 1`,
  ).bind(user.id, sessionId, generation, chunkNumber).first<{
    start_offset: number; end_offset: number; byte_count: number; plaintext_sha256: string;
  }>();
  if (!row) return jsonError(404, "chunk_not_found");

  const r2Key = chunkR2Key(user.id, sessionId, generation, chunkNumber);
  const obj = await env.SESSIONS_BUCKET.get(r2Key);
  if (!obj) return jsonError(404, "chunk_bytes_missing");

  const ciphertext = new Uint8Array(await obj.arrayBuffer());
  // Reconstruct AAD from the D1 row state (the source of truth). The
  // R2 customMetadata is diagnostic only — the worker never trusts it
  // for AAD reconstruction.
  const aad: ChunkAad = {
    owner_id: user.id,
    session_id: sessionId,
    bytes_generation: generation,
    chunk_number: chunkNumber,
    start_offset: row.start_offset,
    end_offset: row.end_offset,
    plaintext_sha256: row.plaintext_sha256,
  };

  let plaintext: Uint8Array;
  try {
    plaintext = await decryptChunk(env.SESSIONS_ENCRYPTION_KEY, aad, ciphertext);
  } catch (err) {
    console.warn("[sessions] decryptChunk failed:", err);
    return jsonError(500, "decrypt_failed");
  }

  return new Response(plaintext, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "private, no-store",
      "x-plaintext-sha256": row.plaintext_sha256,
      "x-chunk-start-offset": String(row.start_offset),
      "x-chunk-end-offset": String(row.end_offset),
      "x-bytes-generation": String(generation),
    },
  });
}

async function handleSessionsBytesReset(
  req: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");
  if (user.tier !== "pro") return jsonError(403, "pro_required");

  const currentGen = await fetchCurrentGeneration(env, user.id, sessionId);
  if (currentGen === null) return jsonError(404, "session_not_found");

  const newGen = currentGen + 1;
  try {
    await env.DB.prepare(
      `UPDATE synced_session_metadata
          SET bytes_generation = ?
        WHERE owner_id = ? AND session_id = ?`,
    ).bind(newGen, user.id, sessionId).run();
  } catch (err) {
    console.warn("[sessions] reset db error:", err);
    return jsonError(500, "db_error");
  }

  // Prior-generation chunk rows are deliberately left in place — the
  // generation filter on manifest / chunk-get makes them effectively
  // tombstoned. R2 objects for old generations stay until v1.1 GC ships;
  // they cost a few cents per heavy user, acceptable.
  return jsonOk({ ok: true, previous_generation: currentGen, current_generation: newGen });
}
