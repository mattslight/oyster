import type { Space } from "../../../shared/types";
import { getJson, patchJson, postJson, del } from "./http";

export async function fetchSpaces(): Promise<Space[]> {
  // Returns [] on failure rather than throwing — callers (App bootstrap)
  // expect a list, and a missing /api/spaces shouldn't crash the surface.
  try {
    return await getJson<Space[]>("/api/spaces");
  } catch {
    return [];
  }
}

export async function updateSpace(spaceId: string, fields: { displayName?: string; color?: string }): Promise<Space> {
  return patchJson<Space>(`/api/spaces/${spaceId}`, fields);
}

export async function convertFolderToSpace(folderName: string, sourceSpaceId: string = "home", merge?: boolean): Promise<Space> {
  return postJson<Space>("/api/spaces/from-folder", { folderName, sourceSpaceId, merge });
}

export async function promoteFolderToSpace(path: string, name?: string): Promise<Space> {
  return postJson<Space>("/api/spaces/from-path", { path, name });
}

// Sources = linked folders attached to a space. The UI can list, attach,
// and detach them via the REST endpoints in this file; MCP via the chat
// bar still works as a parallel path. (#266)
export interface SpaceSource {
  id: string;
  space_id: string;
  type: "local_folder";
  path: string;
  label: string | null;
  added_at: string;
  removed_at: string | null;
}

export async function fetchSpaceSources(spaceId: string, signal?: AbortSignal): Promise<SpaceSource[]> {
  return getJson<SpaceSource[]>(`/api/spaces/${encodeURIComponent(spaceId)}/sources`, signal);
}

export async function addSpaceSource(spaceId: string, path: string): Promise<SpaceSource> {
  return postJson<SpaceSource>(`/api/spaces/${encodeURIComponent(spaceId)}/sources`, { path });
}

export async function removeSpaceSource(spaceId: string, sourceId: string): Promise<void> {
  return del(`/api/spaces/${encodeURIComponent(spaceId)}/sources/${encodeURIComponent(sourceId)}`);
}

export async function deleteSpace(spaceId: string, folderName?: string): Promise<void> {
  return del(`/api/spaces/${spaceId}`, folderName ? { folderName } : undefined);
}
