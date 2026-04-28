import { useEffect, useRef, useState } from "react";
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
//
// A monotonically-increasing request id guards against an out-of-order
// resolve when several `session_changed` events fire in quick succession.
// Only the response from the latest in-flight fetch is allowed to update
// state; older replies are discarded.
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
  const latestReqId = useRef(0);

  useEffect(() => {
    const reqId = ++latestReqId.current;
    setLoading(true);
    fetchSessions()
      .then((rows) => {
        if (reqId !== latestReqId.current) return;
        setSessions(rows);
        setError(null);
      })
      .catch((err) => {
        if (reqId !== latestReqId.current) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (reqId !== latestReqId.current) return;
        setLoading(false);
      });
  }, [tick]);

  useEffect(() => {
    return subscribeUiEvents((event) => {
      if (event.command === "session_changed") setTick((n) => n + 1);
    });
  }, []);

  return { sessions, loading, error, refresh: () => setTick((n) => n + 1) };
}
