// /oauth/*, /.well-known/oauth-*, /mcp, /api/mcp/status — extracted
// from index.ts.
//
// The OAuth dance is intentionally a no-op (localhost-only Oyster doesn't
// authenticate clients): the discovery + register + authorize + token
// endpoints exist solely so MCP SDK clients that probe for them don't
// fail. Real auth lives in the Cloudflare Worker (infra/auth-worker/).
//
// /mcp is the heavy one — wires StreamableHTTPServerTransport into a
// freshly-created McpServer per request, with telemetry routing for
// external agents only.

import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../mcp-server.js";
import {
  recordExternalRequest,
  listExternalClients,
  externalClientCount,
  lastConnectedAt,
} from "../mcp-client-tracker.js";
import type { ArtifactStore } from "../artifact-store.js";
import type { ArtifactService } from "../artifact-service.js";
import type { IconGenerator } from "../icon-generator.js";
import type { SpaceService } from "../space-service.js";
import type { MemoryProvider } from "../memory-store.js";
import type { SessionStore, SessionAgent } from "../session-store.js";
import type { UiCommand } from "../../../shared/types.js";
import type { RouteCtx } from "../http-utils.js";

export interface OAuthMcpRouteDeps {
  preferredPort: number;
  store: ArtifactStore;
  artifactService: ArtifactService;
  iconGenerator: IconGenerator;
  spaceService: SpaceService;
  memoryProvider: MemoryProvider;
  sessionStore: SessionStore;
  pendingReveals: Set<string>;
  broadcastUiEvent: (event: UiCommand) => void;
  userlandDir: string;
  getNativeSourcePath: (spaceId: string) => string;
}

export async function tryHandleOAuthMcpRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: RouteCtx,
  deps: OAuthMcpRouteDeps,
): Promise<boolean> {
  const { sendJson, rejectIfNonLocalOrigin } = ctx;
  const {
    preferredPort, store, artifactService, iconGenerator, spaceService,
    memoryProvider, sessionStore, pendingReveals, broadcastUiEvent,
    userlandDir, getNativeSourcePath,
  } = deps;
  const BASE = `http://localhost:${preferredPort}`;

  // ── No-op OAuth for MCP SDK (localhost only, no real auth) ──

  if (url === "/.well-known/oauth-protected-resource/mcp" || url === "/.well-known/oauth-protected-resource/mcp/") {
    sendJson({ resource: `${BASE}/mcp`, authorization_servers: [`${BASE}/`], scopes_supported: [] });
    return true;
  }
  if (url === "/.well-known/oauth-authorization-server") {
    sendJson({
      issuer: `${BASE}/`,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    });
    return true;
  }
  if (url === "/oauth/register" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed: { client_name?: string };
    try { parsed = JSON.parse(body || "{}"); } catch { sendJson({ error: "Invalid JSON body" }, 400); return true; }
    sendJson({ client_id: "oyster-local", client_name: parsed.client_name || "oyster", client_secret: "none", redirect_uris: ["http://localhost"] }, 201);
    return true;
  }
  if (url.startsWith("/oauth/authorize")) {
    const params = new URL(url, BASE).searchParams;
    const redirect = params.get("redirect_uri") || `${BASE}/`;
    const state = params.get("state") || "";
    const sep = redirect.includes("?") ? "&" : "?";
    res.writeHead(302, { Location: `${redirect}${sep}code=oyster-local-code&state=${state}` });
    res.end();
    return true;
  }
  if (url === "/oauth/token" && req.method === "POST") {
    sendJson({ access_token: "oyster-local-token", token_type: "bearer", expires_in: 86400 });
    return true;
  }

  // ── MCP server ──
  if (url === "/mcp" || url.startsWith("/mcp/") || url.startsWith("/mcp?")) {
    // Localhost-only: reject non-local origins and don't emit wildcard CORS
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.writeHead(403).end("Forbidden");
      return true;
    }
    // Override the wildcard CORS header set at the top of handleHttpRequest
    res.setHeader("Access-Control-Allow-Origin", origin || `http://localhost:${preferredPort}`);

    // `?internal=1` = Oyster's own embedded OpenCode subprocess; anything
    // else is an external agent (Claude Code / Cursor / etc.). The query
    // param is set at config-write time when we compose OpenCode's mcp URL.
    // Parse properly — substring matching would false-positive on
    // `?notinternal=1` or other values containing the literal.
    const isInternal = new URL(url, "http://localhost").searchParams.get("internal") === "1";
    let externalUa: string | null = null;

    if (!isInternal) {
      const { userAgent, isNew } = recordExternalRequest(req.headers["user-agent"]);
      externalUa = userAgent;
      if (isNew) {
        // Broadcast a bare "a new client connected" signal — enough for
        // the dock to flip step 1, with no UA leaked on the SSE stream
        // even if the origin gate is somehow bypassed. Exact UA is still
        // available via /api/mcp/status (local-origin only).
        broadcastUiEvent({
          version: 1,
          command: "mcp_client_connected",
          payload: { at: new Date().toISOString() },
        });
      }
    }

    // R6 (#310): map the calling MCP client to the session it's most likely
    // running inside, so memory writes/recalls get attributed. Internal
    // (?internal=1) is Oyster's own OpenCode subprocess → opencode session.
    // External claude-code / codex agents map to their respective sessions.
    // Codex attribution is best-effort today: there's no codex watcher yet
    // (#298 — that's the 0.9.0 multi-agent ingestion epic), so the lookup
    // will typically return no row and resolveActiveSessionId yields null.
    // The memory store falls back to NULL attribution gracefully. Other
    // UAs (Cursor, etc.) likewise fall through to null.
    const ua = externalUa ?? "";
    const attributableAgent: SessionAgent | null =
      isInternal ? "opencode"
      : /claude/i.test(ua) ? "claude-code"
      : /codex/i.test(ua) ? "codex"
      : null;
    const resolveActiveSessionId = (): string | null => {
      if (!attributableAgent) return null;
      return sessionStore.getMostRecentActiveByAgent(attributableAgent)?.id ?? null;
    };

    const mcpServer = createMcpServer({
      store,
      service: artifactService,
      userlandDir,
      getNativeSourcePath,
      iconGenerator,
      spaceService,
      memoryProvider,
      sessionStore,
      pendingReveals,
      broadcastUiEvent,
      clientContext: isInternal ? { isInternal: true } : { isInternal: false, userAgent: externalUa ?? "unknown" },
      resolveActiveSessionId,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); mcpServer.close(); });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
    return true;
  }

  // ── MCP status (onboarding fallback) ──
  // Local-origin only — the response discloses which MCP clients are
  // connected (user-agent strings + timestamps), which a cross-origin
  // site running in the same browser shouldn't be able to enumerate.
  if (url === "/api/mcp/status" && req.method === "GET") {
    if (rejectIfNonLocalOrigin()) return true;
    sendJson({
      connected_clients: externalClientCount(),
      last_client_connected_at: lastConnectedAt(),
      clients: listExternalClients(),
    });
    return true;
  }

  return false;
}
