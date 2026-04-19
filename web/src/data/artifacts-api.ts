export type { Artifact, ArtifactKind, ArtifactStatus, IconStatus } from "../../../shared/types";
import type { Artifact } from "../../../shared/types";

// Our mutation endpoints return `{error: "…"}` on failure. Surface that
// message in thrown Error objects so UI alert()s show something actionable
// instead of just "Update failed: 400". Best-effort: if the body isn't
// JSON or doesn't carry `.error`, fall back to the status.
async function throwFromResponse(res: Response, fallback: string): Promise<never> {
  const body = await res.json().catch(() => null) as { error?: string } | null;
  throw new Error(body?.error || `${fallback}: ${res.status}`);
}

export async function fetchArtifacts(): Promise<Artifact[]> {
  const res = await fetch("/api/artifacts");
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
}

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
  const res = await fetch(`/api/artifacts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) await throwFromResponse(res, "Update failed");
  return res.json();
}

export async function archiveArtifact(id: string): Promise<void> {
  const res = await fetch(`/api/artifacts/${encodeURIComponent(id)}/archive`, { method: "POST" });
  if (!res.ok) await throwFromResponse(res, "Archive failed");
}

export async function listArchivedArtifacts(): Promise<Artifact[]> {
  const res = await fetch("/api/artifacts/archived");
  if (!res.ok) await throwFromResponse(res, "List archived failed");
  return res.json();
}

export async function restoreArtifact(id: string): Promise<void> {
  const res = await fetch(`/api/artifacts/${encodeURIComponent(id)}/restore`, { method: "POST" });
  if (!res.ok) await throwFromResponse(res, "Restore failed");
}

export async function uninstallPlugin(id: string): Promise<void> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(id)}/uninstall`, { method: "POST" });
  if (!res.ok) await throwFromResponse(res, "Uninstall failed");
}

export async function renameGroup(
  spaceId: string,
  oldName: string,
  newName: string,
): Promise<{ updated: number }> {
  const res = await fetch("/api/groups", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ space_id: spaceId, old_name: oldName, new_name: newName }),
  });
  if (!res.ok) await throwFromResponse(res, "Rename group failed");
  return res.json();
}

export async function archiveGroup(spaceId: string, name: string): Promise<{ archived: number }> {
  const res = await fetch("/api/groups/archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ space_id: spaceId, name }),
  });
  if (!res.ok) await throwFromResponse(res, "Archive group failed");
  return res.json();
}
