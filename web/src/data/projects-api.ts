import { getJson, postJson } from "./http";

// Mirrors `Project` in server/src/project-service.ts. Defined locally to
// avoid a server-side type import that would pull in better-sqlite3 types.
export interface Project {
  id: string;
  spaceId: string;
  name: string;
  createdAt: string;
}

export async function fetchProjectsForSpace(spaceId: string, signal?: AbortSignal): Promise<Project[]> {
  try {
    return await getJson<Project[]>(`/api/projects?space_id=${encodeURIComponent(spaceId)}`, signal);
  } catch {
    return [];
  }
}

export async function createProject(spaceId: string, name: string): Promise<Project> {
  return postJson<Project>("/api/projects", { space_id: spaceId, name });
}

// Bulk-tag every session whose `cwd === args.cwd` and is not yet bound
// to a project. Used by the orphan-recovery flow: pick an existing project
// or create one, then sweep orphans into it. Returns the number claimed.
export async function claimOrphan(projectId: string, cwd: string): Promise<{ claimed: number }> {
  return postJson<{ claimed: number }>(`/api/projects/${encodeURIComponent(projectId)}/claim`, { cwd });
}
