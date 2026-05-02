export type { Artifact, ArtifactKind, ArtifactStatus, IconStatus, SessionJoinedForArtifact } from "../../../shared/types";
import type { Artifact, SessionJoinedForArtifact } from "../../../shared/types";
import { getJson, patchJson, postJson, postEmpty } from "./http";

export async function fetchArtifacts(): Promise<Artifact[]> {
  return getJson<Artifact[]>("/api/artifacts");
}

// startApp/stopApp keep their bespoke shape: server routes are GETs and the
// callers in App.tsx tolerate any response (no throw on non-OK). Promoting
// to getJson would change that contract — out of scope for this refactor.
export async function startApp(name: string): Promise<{ status: string; port?: number }> {
  const res = await fetch(`/api/apps/${name}/start`);
  return res.json();
}

export async function stopApp(name: string): Promise<{ status: string }> {
  const res = await fetch(`/api/apps/${name}/stop`);
  return res.json();
}

export async function updateArtifact(
  id: string,
  fields: { label?: string; group_name?: string | null },
): Promise<Artifact> {
  return patchJson<Artifact>(`/api/artifacts/${encodeURIComponent(id)}`, fields);
}

export async function archiveArtifact(id: string): Promise<void> {
  return postEmpty(`/api/artifacts/${encodeURIComponent(id)}/archive`);
}

export async function listArchivedArtifacts(): Promise<Artifact[]> {
  return getJson<Artifact[]>("/api/artifacts/archived");
}

export async function restoreArtifact(id: string): Promise<void> {
  return postEmpty(`/api/artifacts/${encodeURIComponent(id)}/restore`);
}

export async function uninstallPlugin(id: string): Promise<void> {
  return postEmpty(`/api/plugins/${encodeURIComponent(id)}/uninstall`);
}

export async function regenerateIcon(id: string): Promise<void> {
  return postEmpty(`/api/artifacts/${encodeURIComponent(id)}/icon/regenerate`);
}

export async function renameGroup(
  spaceId: string,
  oldName: string,
  newName: string,
): Promise<{ updated: number }> {
  return patchJson<{ updated: number }>("/api/groups", {
    space_id: spaceId,
    old_name: oldName,
    new_name: newName,
  });
}

export async function archiveGroup(spaceId: string, name: string): Promise<{ archived: number }> {
  return postJson<{ archived: number }>("/api/groups/archive", { space_id: spaceId, name });
}

export async function fetchSessionsForArtifact(
  id: string,
  signal?: AbortSignal,
): Promise<SessionJoinedForArtifact[]> {
  return getJson<SessionJoinedForArtifact[]>(
    `/api/artifacts/${encodeURIComponent(id)}/sessions`,
    signal,
  );
}

