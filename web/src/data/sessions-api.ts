export type {
  Session,
  SessionState,
  SessionAgent,
  SessionEvent,
  SessionEventRole,
  SessionArtifact,
  SessionArtifactRole,
  SessionArtifactJoined,
  SessionJoinedForArtifact,
} from "../../../shared/types";
import type {
  Session,
  SessionEvent,
  SessionArtifactJoined,
} from "../../../shared/types";
import { ApiError, getJson } from "./http";

export async function fetchSessions(): Promise<Session[]> {
  return getJson<Session[]>("/api/sessions");
}

export async function fetchSession(id: string, signal?: AbortSignal): Promise<Session> {
  try {
    return await getJson<Session>(`/api/sessions/${encodeURIComponent(id)}`, signal);
  } catch (err) {
    // Callers (SessionInspector) branch on this to render a "no longer
    // available" state vs. a generic error banner.
    if (err instanceof ApiError && err.status === 404) {
      throw new SessionNotFoundError(id);
    }
    throw err;
  }
}

export interface FetchSessionEventsOpts {
  // Cursor pagination. Pass `before` to load older events; `after` to fetch
  // only events newer than the cursor (live append). Mutually exclusive.
  before?: number;
  after?: number;
  /** Centred window: returns up to `limit` events centred on the
   *  target. The target itself is included (counted within the older
   *  half). Used to deep-link into the middle of a long transcript
   *  (e.g. Spotlight click-through, #329). Mutually exclusive with
   *  before/after. */
  around?: number;
  // Server caps at 1000 default; pass to override (max 10_000).
  limit?: number;
  signal?: AbortSignal;
}

export async function fetchSessionEvents(
  id: string,
  opts: FetchSessionEventsOpts = {},
): Promise<SessionEvent[]> {
  const params = new URLSearchParams();
  if (opts.before !== undefined) params.set("before", String(opts.before));
  if (opts.after !== undefined) params.set("after", String(opts.after));
  if (opts.around !== undefined) params.set("around", String(opts.around));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const url = `/api/sessions/${encodeURIComponent(id)}/events${qs ? `?${qs}` : ""}`;
  return getJson<SessionEvent[]>(url, opts.signal);
}

export async function fetchSessionArtifacts(id: string, signal?: AbortSignal): Promise<SessionArtifactJoined[]> {
  return getJson<SessionArtifactJoined[]>(`/api/sessions/${encodeURIComponent(id)}/artifacts`, signal);
}

/** R6 traceable recall: memories tied to this session — written by it
 *  (source_session_id == :id) and pulled by it (logged in memory_recalls). */
export interface SessionMemoryEntry {
  id: string;
  content: string;
  space_id: string | null;
  tags: string[];
  created_at: string;
  source_session_id: string | null;
  source_session_title: string | null;
  /** When *this session* recalled this memory. Only present on rows in
   *  the `pulled` list — the memory's own created_at can be days/weeks
   *  older than the recall event. Undefined for `written` rows. */
  recalled_at?: string;
}

export interface SessionMemory {
  written: SessionMemoryEntry[];
  pulled: SessionMemoryEntry[];
}

export async function fetchSessionMemory(id: string, signal?: AbortSignal): Promise<SessionMemory> {
  return getJson<SessionMemory>(`/api/sessions/${encodeURIComponent(id)}/memory`, signal);
}

/** A transcript-search hit returned by GET /api/sessions/search.
 *  Slim by design — snippet already covers what the UI renders, and
 *  click-through loads the full event from the inspector. */
export interface TranscriptHit {
  event_id: number;
  session_id: string;
  session_title: string | null;
  role: string;
  ts: string;
  snippet: string;
}

export async function searchTranscripts(
  query: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<TranscriptHit[]> {
  const params = new URLSearchParams({ q: query });
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  return getJson<TranscriptHit[]>(`/api/sessions/search?${params.toString()}`, opts.signal);
}

// The list endpoint strips `raw` from every event to keep the payload
// reasonable on long sessions (raw can be megabytes per tool result).
// Use this to lazy-fetch one event's raw on-demand — e.g. when the user
// clicks "expand" on a tool-call turn.
export async function fetchSessionEventRaw(
  sessionId: string,
  eventId: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const ev = await getJson<SessionEvent>(
    `/api/sessions/${encodeURIComponent(sessionId)}/events/${eventId}`,
    signal,
  );
  return ev.raw;
}

export class SessionNotFoundError extends Error {
  sessionId: string;
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.sessionId = sessionId;
    this.name = "SessionNotFoundError";
  }
}
