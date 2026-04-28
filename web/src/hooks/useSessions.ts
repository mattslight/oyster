import { useEffect, useState } from "react";
import { fetchSessions } from "../data/sessions-api";
import type { Session } from "../data/sessions-api";
import { subscribeUiEvents } from "../data/ui-events";

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
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSessions()
      .then((rows) => {
        if (cancelled) return;
        setSessions(rows);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [tick]);

  useEffect(() => {
    return subscribeUiEvents((event) => {
      if (event.command === "session_changed") setTick((n) => n + 1);
    });
  }, []);

  return { sessions, loading, error, refresh: () => setTick((n) => n + 1) };
}
