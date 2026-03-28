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

export async function deleteSpace(spaceId: string): Promise<void> {
  await fetch(`/api/spaces/${spaceId}`, { method: "DELETE" });
  // best-effort — ignore errors (wizard uses this only for cleanup)
}
