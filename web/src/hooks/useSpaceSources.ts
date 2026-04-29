import { useEffect, useRef, useState } from "react";
import { fetchSpaceSources } from "../data/spaces-api";
import type { SpaceSource } from "../data/spaces-api";

// Per-space sources. The Home UI can attach/detach via REST endpoints,
// so call `refresh()` after those mutations to pick up the new list.
// SSE subscription is future work; today the hook re-fetches on
// `spaceId` change or an explicit `refresh()` tick.
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
  // Clear stale `sources`/`error` immediately when the user navigates to
  // a different space. Without this, switching from a 6-source space
  // to a 0-source one would briefly show the previous list (or a
  // stale error masking the loading state). Manual `refresh()` calls
  // hit the same effect via `tick` but stay on the same spaceId, so
  // they retain the current data while the new request is in flight.
  const previousSpaceId = useRef<string | null>(null);
  if (previousSpaceId.current !== spaceId) {
    previousSpaceId.current = spaceId;
    if (sources.length > 0) setSources([]);
    if (error) setError(null);
  }

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
