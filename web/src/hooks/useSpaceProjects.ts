import { fetchProjectsForSpace, type Project } from "../data/projects-api";
import { useFetched } from "./useFetched";

// Per-space projects. Mutation endpoints (createProject, claimOrphan,
// renameProject, deleteProject) call `refresh()` after success to pull
// the new list. SSE wiring is future work — today the hook re-fetches
// on `spaceId` change or an explicit `refresh()` tick.
export function useSpaceProjects(spaceId: string | null): {
  projects: Project[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
} {
  const { data, loading, error, refresh } = useFetched<Project[]>(
    (signal) => spaceId ? fetchProjectsForSpace(spaceId, signal) : Promise.resolve([]),
    [],
    { key: spaceId, enabled: !!spaceId },
  );
  return { projects: data, loading, error, refresh };
}
