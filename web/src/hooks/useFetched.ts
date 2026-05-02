import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { subscribeUiEvents } from "../data/ui-events";

// Generic "fetch + tick + abort + (optional) SSE refresh" hook.
//
// Used to be three near-identical hooks (useSessions / useMemories /
// useSpaceSources). The shared shape:
// 1. Fetch on mount (and when `key` or `tick` changes).
// 2. Stash a monotonically-increasing reqId so an out-of-order resolve
//    from a slower earlier fetch doesn't overwrite a fresh one.
// 3. AbortController scoped to each effect run, cancelled on cleanup.
// 4. Optional SSE event name — firing the named UI command bumps tick
//    and triggers a refetch.
// 5. Optional `key` for parameterised fetches (e.g. spaceId). Changing
//    the key clears stale data pre-paint so the previous payload doesn't
//    flash before the new fetch resolves.
// 6. Optional `enabled` flag — when false, resets to `initial` and
//    skips fetching (used by useSpaceSources for the null-space case).

interface UseFetchedOpts {
  /** Refetch when this value changes; clears prior data pre-paint. */
  key?: unknown;
  /** When false, skip fetching and hold `initial`. Default true. */
  enabled?: boolean;
  /** UI SSE command name; firing it triggers a refetch. */
  ssEvent?: string;
}

export function useFetched<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  initial: T,
  opts: UseFetchedOpts = {},
): { data: T; loading: boolean; error: Error | null; refresh: () => void } {
  const { key, enabled = true, ssEvent } = opts;
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const latestReqId = useRef(0);
  // Hold initial in a ref so callers can pass `[]` literally without
  // tripping the deps array; the effects below read .current on demand.
  const initialRef = useRef(initial);

  // Pre-paint clear on key change. Without this, switching from one
  // keyed view to another briefly shows the previous payload before
  // the new fetch resolves.
  useLayoutEffect(() => {
    if (key !== undefined) {
      setData(initialRef.current);
      setError(null);
    }
  }, [key]);

  useEffect(() => {
    if (!enabled) {
      setData(initialRef.current);
      setLoading(false);
      setError(null);
      return;
    }
    const reqId = ++latestReqId.current;
    setLoading(true);
    const ac = new AbortController();
    fetcher(ac.signal)
      .then((value) => {
        if (reqId !== latestReqId.current) return;
        setData(value);
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
    // fetcher is intentionally omitted — callers commonly pass an inline
    // arrow, which would re-trigger on every render. tick + key + enabled
    // are the real refetch triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, key, enabled]);

  useEffect(() => {
    if (!ssEvent) return;
    return subscribeUiEvents((event) => {
      if (event.command === ssEvent) setTick((n) => n + 1);
    });
  }, [ssEvent]);

  return { data, loading, error, refresh: () => setTick((n) => n + 1) };
}
