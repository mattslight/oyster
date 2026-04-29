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

export async function fetchSessionEvents(id: string, signal?: AbortSignal): Promise<SessionEvent[]> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/events`, { signal });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
}

export async function fetchSessionArtifacts(id: string, signal?: AbortSignal): Promise<SessionArtifactJoined[]> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/artifacts`, { signal });
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
