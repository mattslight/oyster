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

export async function fetchSessions(): Promise<Session[]> {
  const res = await fetch("/api/sessions");
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
}

export async function fetchSession(id: string, signal?: AbortSignal): Promise<Session> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { signal });
  if (res.status === 404) throw new SessionNotFoundError(id);
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
}

export interface FetchSessionEventsOpts {
  // Cursor pagination. Pass `before` to load older events; `after` to fetch
  // only events newer than the cursor (live append). Mutually exclusive.
  before?: number;
  after?: number;
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
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const url = `/api/sessions/${encodeURIComponent(id)}/events${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { signal: opts.signal });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
}

export async function fetchSessionArtifacts(id: string, signal?: AbortSignal): Promise<SessionArtifactJoined[]> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/artifacts`, { signal });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
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
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/memory`, { signal });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
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
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/events/${eventId}`,
    { signal },
  );
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  const ev = (await res.json()) as SessionEvent;
  return ev.raw;
}

export class SessionNotFoundError extends Error {
  constructor(public sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}
