// Surfaces memories created via mcp__oyster__remember. v1 is read-only —
// writes still go through the MCP tool surface.

export interface Memory {
  id: string;
  content: string;
  space_id: string | null;
  tags: string[];
  created_at: string;
  /** R6 traceable recall (#310): originating session, NULL for legacy
   *  rows or memories written outside an attributable session. */
  source_session_id: string | null;
}

export async function fetchMemories(spaceId?: string | null, signal?: AbortSignal): Promise<Memory[]> {
  const url = spaceId
    ? `/api/memories?space_id=${encodeURIComponent(spaceId)}`
    : "/api/memories";
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
}

export interface CreateMemoryInput {
  content: string;
  space_id?: string | null;
  tags?: string[];
}

export async function createMemory(input: CreateMemoryInput): Promise<Memory> {
  const res = await fetch("/api/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: input.content,
      space_id: input.space_id || undefined,
      tags: input.tags?.length ? input.tags : undefined,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = `Server returned ${res.status}`;
    try {
      const err = JSON.parse(text);
      if (typeof err.error === "string") message = err.error;
    } catch { /* not JSON */ }
    throw new Error(message);
  }
  return res.json();
}
