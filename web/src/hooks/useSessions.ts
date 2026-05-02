import { fetchSessions } from "../data/sessions-api";
import type { Session } from "../data/sessions-api";
import { useFetched } from "./useFetched";

// Fetches /api/sessions on mount and refetches whenever the server emits a
// `session_changed` SSE event (state transition, new event row, etc.).
//
// We refetch the full list rather than patching by id because the server
// already orders sessions by last_event_at and the payload is small. If the
// list ever grows enough to make a round-trip noticeable, we'll switch to
// per-id deltas — but that's #257-and-friends territory, not v1.
export function useSessions(): {
  sessions: Session[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
} {
  const { data, loading, error, refresh } = useFetched<Session[]>(
    () => fetchSessions(),
    [],
    { ssEvent: "session_changed" },
  );
  return { sessions: data, loading, error, refresh };
}
