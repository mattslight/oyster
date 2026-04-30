import type { IncomingMessage, ServerResponse } from "node:http";
import type { SpaceService } from "./space-service.js";
import { slugify } from "./utils.js";

/**
 * Handle /api/spaces/* HTTP routes used by the web UI.
 * Creation, path attachment, and scanning are MCP-only — agents drive those.
 * Returns true if the request was handled, false to fall through.
 */
export async function handleSpacesRequest(
  url: string,
  req: IncomingMessage,
  res: ServerResponse,
  spaceService: SpaceService,
  /** Optional — when supplied, lifecycle changes that touch sessions
   *  (DELETE space cascades sessions.space_id to NULL) trigger a refetch
   *  on the client by emitting a `session_changed` event. */
  onSessionsChanged?: () => void,
): Promise<boolean> {

  // POST /api/spaces/from-folder — convert a folder group (under home) into its own space.
  // Used by the desktop right-click "Move folder to space" flow.
  if (url === "/api/spaces/from-folder" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer | string) => (body += chunk));
    req.on("end", () => {
      try {
        const { folderName, sourceSpaceId, merge } = JSON.parse(body);
        if (!folderName) throw new Error("folderName is required");
        let space: ReturnType<typeof spaceService.getSpace>;
        const existing = spaceService.getSpace(slugify(folderName));
        if (existing && merge) {
          space = existing;
        } else {
          space = spaceService.createSpace({ name: folderName });
        }
        spaceService.convertFolderToSpace(sourceSpaceId ?? "home", folderName, space!.id);
        res.writeHead(existing && merge ? 200 : 201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(space));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    return true;
  }

  // GET /api/spaces — list spaces
  if (url === "/api/spaces" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(spaceService.listSpaces()));
    return true;
  }

  const spaceIdMatch = url.match(/^\/api\/spaces\/([^/]+)$/);
  if (spaceIdMatch && req.method === "PATCH") {
    return new Promise<boolean>((resolve) => {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        try {
          const { displayName, color } = JSON.parse(body);
          const updated = spaceService.updateSpace(spaceIdMatch[1], { displayName, color });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(updated));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
        resolve(true);
      });
    });
  }
  if (spaceIdMatch && req.method === "DELETE") {
    return new Promise<boolean>((resolve) => {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          spaceService.deleteSpace(spaceIdMatch[1], parsed.folderName);
          // Cascade fired sessions.space_id → NULL on every session in the
          // deleted space. Tell connected clients to refetch the session
          // list so the UI moves them back to Elsewhere immediately rather
          // than waiting for the next watcher tick.
          onSessionsChanged?.();
          res.writeHead(204);
          res.end();
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
        resolve(true);
      });
    });
  }

  return false;
}
