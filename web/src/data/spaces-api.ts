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

export async function deleteSpace(spaceId: string, folderName?: string): Promise<void> {
  return del(`/api/spaces/${spaceId}`, folderName ? { folderName } : undefined);
}
