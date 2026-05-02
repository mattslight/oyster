import { fetchSpaceSources } from "../data/spaces-api";
import type { SpaceSource } from "../data/spaces-api";
import { useFetched } from "./useFetched";

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
  const { data, loading, error, refresh } = useFetched<SpaceSource[]>(
    (signal) => spaceId ? fetchSpaceSources(spaceId, signal) : Promise.resolve([]),
    [],
    { key: spaceId, enabled: !!spaceId },
  );
  return { sources: data, loading, error, refresh };
}
