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
