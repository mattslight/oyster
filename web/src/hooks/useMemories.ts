import { useEffect, useRef, useState } from "react";
import { fetchMemories } from "../data/memories-api";
import type { Memory } from "../data/memories-api";
import { subscribeUiEvents } from "../data/ui-events";

// Mirror of useSessions / useArtifacts. Memories list rarely changes during
// a session — they're written by an agent calling `remember`, infrequent —
// so a single fetch on mount + on `memory_changed` SSE is plenty. We don't
// scope the fetch by space client-side filtering is cheap.
//
// `memory_changed` isn't emitted yet (server doesn't push memory updates
// over SSE today). Subscribing now keeps the hook future-proof: when the
// memory store gains write hooks the list refreshes without UI changes.
export function useMemories(): {
  memories: Memory[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
} {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const latestReqId = useRef(0);

  useEffect(() => {
    const reqId = ++latestReqId.current;
    setLoading(true);
    fetchMemories()
      .then((rows) => {
        if (reqId !== latestReqId.current) return;
        setMemories(rows);
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
      if (event.command === "memory_changed") setTick((n) => n + 1);
    });
  }, []);

  return { memories, loading, error, refresh: () => setTick((n) => n + 1) };
}
