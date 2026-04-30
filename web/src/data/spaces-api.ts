import type { Space } from "../../../shared/types";

export async function fetchSpaces(): Promise<Space[]> {
  const res = await fetch("/api/spaces");
  if (!res.ok) return [];
  return res.json();
}

export async function updateSpace(spaceId: string, fields: { displayName?: string; color?: string }): Promise<Space> {
  const res = await fetch(`/api/spaces/${spaceId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function convertFolderToSpace(folderName: string, sourceSpaceId: string = "home", merge?: boolean): Promise<Space> {
  const res = await fetch("/api/spaces/from-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderName, sourceSpaceId, merge }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function promoteFolderToSpace(path: string, name?: string): Promise<Space> {
  const res = await fetch("/api/spaces/from-path", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
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
  const res = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/sources`, { signal });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
}

async function readErr(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: string };
    if (typeof body.error === "string") return body.error;
  } catch { /* not JSON */ }
  return `HTTP ${res.status}`;
}

export async function addSpaceSource(spaceId: string, path: string): Promise<SpaceSource> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/sources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(await readErr(res));
  return res.json();
}

export async function removeSpaceSource(spaceId: string, sourceId: string): Promise<void> {
  const res = await fetch(
    `/api/spaces/${encodeURIComponent(spaceId)}/sources/${encodeURIComponent(sourceId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(await readErr(res));
}

export async function deleteSpace(spaceId: string, folderName?: string): Promise<void> {
  const opts: RequestInit = { method: "DELETE" };
  if (folderName) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify({ folderName });
  }
  const res = await fetch(`/api/spaces/${spaceId}`, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}
