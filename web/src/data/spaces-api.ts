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
  /** Set by the server on GET: false when the folder no longer exists on
   *  disk. Drives the "Path missing" warning chip on the tile so the user
   *  can choose to update the path or detach. Older builds may omit. */
  pathExists?: boolean;
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

/** Update a source's filesystem path (folder rename / unmounted-drive
 *  recovery) and/or its display label. Path existence is advisory — the
 *  server accepts a non-existent path and the next GET returns
 *  `pathExists: false`. */
export async function updateSpaceSource(
  spaceId: string,
  sourceId: string,
  fields: { path?: string; label?: string | null },
): Promise<SpaceSource> {
  return patchJson<SpaceSource>(
    `/api/spaces/${encodeURIComponent(spaceId)}/sources/${encodeURIComponent(sourceId)}`,
    fields,
  );
}

export async function deleteSpace(spaceId: string, folderName?: string): Promise<void> {
  return del(`/api/spaces/${spaceId}`, folderName ? { folderName } : undefined);
}
