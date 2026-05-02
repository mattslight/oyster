// Surfaces memories created via mcp__oyster__remember. v1 is read-only —
// writes still go through the MCP tool surface.
import { getJson, postJson } from "./http";

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
  return getJson<Memory[]>(url, signal);
}

export interface CreateMemoryInput {
  content: string;
  space_id?: string | null;
  tags?: string[];
}

export async function createMemory(input: CreateMemoryInput): Promise<Memory> {
  return postJson<Memory>("/api/memories", {
    content: input.content,
    space_id: input.space_id || undefined,
    tags: input.tags?.length ? input.tags : undefined,
  });
}
