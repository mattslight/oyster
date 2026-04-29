import { useEffect, useRef, useState } from "react";
import { fetchSpaceSources } from "../data/spaces-api";
import type { SpaceSource } from "../data/spaces-api";

// Per-space sources. Read-only — attach/detach happen via MCP, so the
// list rarely changes during a session and a single fetch on space change
// is enough. We don't subscribe to SSE today; if a `space_changed` event
// surfaces later, refetch via `refresh()`.
export function useSpaceSources(spaceId: string | null): {
  sources: SpaceSource[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
} {
  const [sources, setSources] = useState<SpaceSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const latestReqId = useRef(0);

  useEffect(() => {
    if (!spaceId) {
      setSources([]);
      setLoading(false);
      setError(null);
      return;
    }
    const reqId = ++latestReqId.current;
    setLoading(true);
    const ac = new AbortController();
    fetchSpaceSources(spaceId, ac.signal)
      .then((rows) => {
        if (reqId !== latestReqId.current) return;
        setSources(rows);
        setError(null);
      })
      .catch((err) => {
        if (reqId !== latestReqId.current || ac.signal.aborted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (reqId !== latestReqId.current) return;
        setLoading(false);
      });
    return () => ac.abort();
  }, [spaceId, tick]);

  return { sources, loading, error, refresh: () => setTick((n) => n + 1) };
}
