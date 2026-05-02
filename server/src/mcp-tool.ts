// MCP tool helper. Replaces the per-call try/catch + JSON.stringify boilerplate
// that surrounded every `server.tool()` handler in mcp-server.ts and
// memory-store.ts. Also folds the `mcp_tool_called` telemetry into the same
// wrapper, retiring the monkey-patch on `server.tool` (and the four `any`
// disables it required).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { UiCommand } from "../../shared/types.js";
import { recordToolCall } from "./mcp-client-tracker.js";

/** Subset of the SDK's CallToolResult shape. Tools always emit text content;
 *  structuredContent is optional on a few that also need a parseable payload
 *  (create_artifact, update_artifact, gather_repo_context). */
export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Telemetry hook. When supplied, every tool invocation records the call
 *  (for /api/mcp/status) and broadcasts an `mcp_tool_called` UI event so the
 *  onboarding action log can show what just happened. Internal callers
 *  (Oyster's own OpenCode subprocess) opt out by passing `undefined` — they
 *  fire many tool calls during normal operation and would flood the log. */
export interface ToolTelemetry {
  broadcastUiEvent: (event: UiCommand) => void;
  userAgent: string;
}

function isToolResponse(v: unknown): v is ToolResponse {
  return (
    typeof v === "object" && v !== null &&
    "content" in v &&
    Array.isArray((v as { content: unknown }).content)
  );
}

/** Wrap a handler return value in the SDK response shape:
 *  - string → { content: [{ type: "text", text }] }
 *  - already a ToolResponse → passed through (handler opted into structuredContent
 *    or chose its own isError shape — typically the few create/update tools)
 *  - anything else → JSON.stringify into a text content block */
function toResponse(value: unknown): ToolResponse {
  if (typeof value === "string") {
    return { content: [{ type: "text", text: value }] };
  }
  if (isToolResponse(value)) return value;
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Convenience for the handful of handlers that need both a text payload
 *  AND structuredContent. Returns the full ToolResponse shape so the helper's
 *  pass-through branch (isToolResponse) recognises it. */
export function withStructured(
  data: unknown,
  structuredContent: Record<string, unknown>,
): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent,
  };
}

/** Curried helper. `makeTool(server, telemetry)` returns a `tool(name, desc,
 *  schema, handler)` function that:
 *   - registers the tool on the SDK server
 *   - wraps the handler return in a ToolResponse (string / object / passthrough)
 *   - catches Error and returns it as `{ ..., isError: true }` instead of throwing
 *   - if telemetry is supplied, records the call and broadcasts the UI event
 *
 *  Handlers can throw any Error; the message becomes the user-visible text. */
export function makeTool(server: McpServer, telemetry?: ToolTelemetry) {
  return function tool<A extends ZodRawShapeCompat>(
    name: string,
    description: string,
    schema: A,
    handler: (args: ShapeOutput<A>) => unknown | Promise<unknown>,
  ): void {
    // The SDK's BaseToolCallback expects a richer CallToolResult shape
    // (image/audio content variants + index signature). Our ToolResponse is
    // a strict subset, but TypeScript won't widen automatically — cast at
    // the boundary so callers keep the narrower, more useful types.
    const cb = async (args: ShapeOutput<A>) => {
      let response: ToolResponse;
      try {
        response = toResponse(await handler(args));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        response = { content: [{ type: "text", text: message }], isError: true };
      }
      if (telemetry) {
        // Best effort — never let telemetry throwing break a tool call.
        try {
          recordToolCall(telemetry.userAgent);
          telemetry.broadcastUiEvent({
            version: 1,
            command: "mcp_tool_called",
            payload: {
              tool: name,
              at: new Date().toISOString(),
              is_error: Boolean(response.isError),
            },
          });
        } catch { /* ignore */ }
      }
      return response;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server.tool(name, description, schema, cb as any);
  };
}

/** The shape of the curried tool registrar returned by `makeTool`. Exported so
 *  registerMemoryTools (in memory-store.ts) can accept it as a parameter. */
export type ToolDefiner = ReturnType<typeof makeTool>;
