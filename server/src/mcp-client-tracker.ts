// Track *external* MCP clients (i.e. anything that isn't Oyster's own
// embedded OpenCode subprocess). Internal requests carry `?internal=1` on
// the /mcp URL — that flag is set at config-write time when we compose
// OpenCode's .opencode/config.toml + opencode.json.
//
// The tracker is the single source of truth for both:
//  - `GET /api/mcp/status` (fallback for the onboarding dock)
//  - `mcp_client_connected` SSE push (the primary auto-advance path)

export interface ExternalMcpClient {
  userAgent: string;
  firstSeenAt: string;
  lastSeenAt: string;
  toolCalls: number;
}

const clients = new Map<string, ExternalMcpClient>();

function normalizeUa(raw: string | string[] | undefined): string {
  if (!raw) return "unknown";
  const s = Array.isArray(raw) ? raw[0] : raw;
  return s.trim().slice(0, 200) || "unknown";
}

/**
 * Record a request from an external MCP client.
 * Returns `{ isNew: true }` the first time a given UA is seen so callers
 * can push a connect event exactly once per session lifetime.
 */
export function recordExternalRequest(
  userAgent: string | string[] | undefined,
): { userAgent: string; isNew: boolean } {
  const ua = normalizeUa(userAgent);
  const existing = clients.get(ua);
  const now = new Date().toISOString();
  if (existing) {
    existing.lastSeenAt = now;
    return { userAgent: ua, isNew: false };
  }
  clients.set(ua, { userAgent: ua, firstSeenAt: now, lastSeenAt: now, toolCalls: 0 });
  return { userAgent: ua, isNew: true };
}

export function recordToolCall(userAgent: string): void {
  const existing = clients.get(userAgent);
  if (existing) {
    existing.toolCalls += 1;
    existing.lastSeenAt = new Date().toISOString();
  }
}

export function listExternalClients(): ExternalMcpClient[] {
  return Array.from(clients.values()).sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
}

export function externalClientCount(): number {
  return clients.size;
}

export function lastConnectedAt(): string | null {
  let latest: string | null = null;
  for (const c of clients.values()) {
    if (!latest || c.firstSeenAt > latest) latest = c.firstSeenAt;
  }
  return latest;
}
