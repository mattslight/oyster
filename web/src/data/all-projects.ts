// Cross-space project list. Mirrors useSpaceProjects but uses the flat
// /api/projects endpoint added for the New Session palette. Kept in a
// separate file so projects-api.ts stays scoped to per-space CRUD.

import { getJson } from "./http";
import { useFetched } from "../hooks/useFetched";
import type { Project } from "./projects-api";

export async function fetchAllProjects(signal?: AbortSignal): Promise<Project[]> {
  return getJson<Project[]>("/api/projects", signal);
}

export function useAllProjects(enabled: boolean): {
  projects: Project[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
} {
  const { data, loading, error, refresh } = useFetched<Project[]>(
    (signal) => fetchAllProjects(signal),
    [],
    { enabled },
  );
  return { projects: data, loading, error, refresh };
}
