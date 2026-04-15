import type { Space, ScanResult } from "../../../shared/types";

export async function fetchSpaces(): Promise<Space[]> {
  const res = await fetch("/api/spaces");
  if (!res.ok) return [];
  return res.json();
}

export async function createSpace(params: { name: string; repoPath?: string }): Promise<Space> {
  const res = await fetch("/api/spaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function triggerScan(spaceId: string): Promise<ScanResult> {
  const res = await fetch(`/api/spaces/${spaceId}/scan`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
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

export async function convertFolderToSpace(folderName: string, sourceSpaceId: string = "home"): Promise<Space> {
  const res = await fetch("/api/spaces/from-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderName, sourceSpaceId }),
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
  await fetch(`/api/spaces/${spaceId}`, opts);
}

export async function addPath(spaceId: string, path: string): Promise<string> {
  const res = await fetch(`/api/spaces/${spaceId}/paths`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  const data = await res.json() as { path: string };
  return data.path;
}
