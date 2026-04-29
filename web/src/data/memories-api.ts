// Surfaces memories created via mcp__oyster__remember. v1 is read-only —
// writes still go through the MCP tool surface.

export interface Memory {
  id: string;
  content: string;
  space_id: string | null;
  tags: string[];
  created_at: string;
}

export async function fetchMemories(spaceId?: string | null, signal?: AbortSignal): Promise<Memory[]> {
  const url = spaceId
    ? `/api/memories?space_id=${encodeURIComponent(spaceId)}`
    : "/api/memories";
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
}
