import { fetchMemories } from "../data/memories-api";
import type { Memory } from "../data/memories-api";
import { useFetched } from "./useFetched";

// Mirror of useSessions. Memories list rarely changes during a session —
// they're written by an agent calling `remember`, infrequent — so a single
// fetch on mount + on `memory_changed` SSE is plenty. We don't scope the
// fetch by space; client-side filtering is cheap.
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
  const { data, loading, error, refresh } = useFetched<Memory[]>(
    () => fetchMemories(),
    [],
    { ssEvent: "memory_changed" },
  );
  return { memories: data, loading, error, refresh };
}
