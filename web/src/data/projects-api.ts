import { getJson, postJson, patchJson, del } from "./http";

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

// Idempotent full attach: creates the project (or adopts an existing one if
// the folder already has a .oyster/id), writes .oyster/id to disk, claims
// orphan sessions at the cwd. Use this from the UI's "Add project" flow
// instead of createProject + claimOrphan — the marker write is what makes
// renames and cross-machine identity work.
export async function attachFolder(
  spaceId: string,
  path: string,
  name?: string,
): Promise<{ project: Project; claimed: number }> {
  return postJson("/api/projects/attach-folder", { space_id: spaceId, path, name });
}

// Bulk-tag every session whose `cwd === args.cwd` and is not yet bound
// to a project. Used by the orphan-recovery flow: pick an existing project
// or create one, then sweep orphans into it. Returns the number claimed.
export async function claimOrphan(projectId: string, cwd: string): Promise<{ claimed: number }> {
  return postJson<{ claimed: number }>(`/api/projects/${encodeURIComponent(projectId)}/claim`, { cwd });
}

export async function renameProject(projectId: string, name: string): Promise<Project> {
  return patchJson<Project>(`/api/projects/${encodeURIComponent(projectId)}`, { name });
}

export async function deleteProject(projectId: string): Promise<void> {
  await del(`/api/projects/${encodeURIComponent(projectId)}`);
}
