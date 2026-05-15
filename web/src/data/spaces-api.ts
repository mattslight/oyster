import type { Space } from "../../../shared/types";
import { getJson, patchJson, postJson, del, ApiError } from "./http";

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
 *  `pathExists: false`.
 *
 *  If the new path is already attached to another active source in the
 *  same space, the server returns 409 with a structured body and we
 *  surface that as a `WouldConsolidateError` so the UI can offer a merge
 *  flow instead. */
export async function updateSpaceSource(
  spaceId: string,
  sourceId: string,
  fields: { path?: string; label?: string | null },
): Promise<SpaceSource> {
  try {
    return await patchJson<SpaceSource>(
      `/api/spaces/${encodeURIComponent(spaceId)}/sources/${encodeURIComponent(sourceId)}`,
      fields,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      const body = (err as ApiError).body as
        | { error?: string; target?: { id: string; label: string | null; path: string; space_id: string }; moves?: { sessionCount: number; artefactCount: number }; sameSpace?: boolean }
        | undefined;
      if (body && body.error === "would_consolidate" && body.target && body.moves) {
        throw new WouldConsolidateError(body.target, body.moves, Boolean(body.sameSpace));
      }
    }
    throw err;
  }
}

export interface ConsolidateTarget {
  id: string;
  label: string | null;
  path: string;
  space_id: string;
}

/** Thrown by updateSpaceSource when the typed path is already attached
 *  to another active source. The UI catches this and shows a merge
 *  confirmation. `sameSpace` is true when the merge is allowed (the
 *  consolidate endpoint requires same-space). */
export class WouldConsolidateError extends Error {
  target: ConsolidateTarget;
  moves: { sessionCount: number; artefactCount: number };
  sameSpace: boolean;
  constructor(
    target: ConsolidateTarget,
    moves: { sessionCount: number; artefactCount: number },
    sameSpace: boolean,
  ) {
    super(`Path is already attached as "${target.label ?? target.path}"`);
    this.name = "WouldConsolidateError";
    this.target = target;
    this.moves = moves;
    this.sameSpace = sameSpace;
  }
}

export async function consolidateSpaceSource(
  spaceId: string,
  fromSourceId: string,
  intoSourceId: string,
): Promise<{ sessionsMoved: number; artefactsMoved: number; into: SpaceSource }> {
  return postJson(
    `/api/spaces/${encodeURIComponent(spaceId)}/sources/${encodeURIComponent(fromSourceId)}/consolidate`,
    { intoSourceId },
  );
}

export async function deleteSpace(spaceId: string, folderName?: string): Promise<void> {
  return del(`/api/spaces/${spaceId}`, folderName ? { folderName } : undefined);
}
