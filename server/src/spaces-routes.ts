import { existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SpaceService } from "./space-service.js";

/**
 * Handle all /api/resolve-folder and /api/spaces/* routes.
 * Returns true if the request was handled, false to fall through to the next handler.
 */
export async function handleSpacesRequest(
  url: string,
  req: IncomingMessage,
  res: ServerResponse,
  spaceService: SpaceService,
): Promise<boolean> {

  // GET /api/resolve-folder?name=... — search common dev dirs for a folder by name
  // Restricted to same-origin (localhost) — probes $HOME filesystem, must not be callable cross-origin
  if (url.startsWith("/api/resolve-folder") && req.method === "GET") {
    const origin = req.headers.origin;
    if (origin && !origin.startsWith("http://localhost") && !origin.startsWith("http://127.0.0.1")) {
      res.writeHead(403);
      res.end("Forbidden");
      return true;
    }
    const folderName = new URL(url, "http://localhost").searchParams.get("name") ?? "";
    if (!folderName) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "name is required" }));
      return true;
    }
    const home = process.env.HOME ?? "";
    const searchRoots = [
      // Home
      home,
      // Dev folders
      `${home}/Dev`, `${home}/dev`, `${home}/Projects`, `${home}/projects`,
      `${home}/code`, `${home}/Code`, `${home}/repos`, `${home}/Repos`,
      `${home}/src`, `${home}/workspace`, `${home}/Workspace`,
      // OS folders
      `${home}/Documents`, `${home}/Desktop`, `${home}/Downloads`, `${home}/Sites`,
      // Cloud sync
      `${home}/Dropbox`, `${home}/OneDrive`, `${home}/OneDrive - Personal`,
      `${home}/Library/Mobile Documents/com~apple~CloudDocs`, // iCloud Drive
      `${home}/Google Drive`, `${home}/My Drive`,
      // Go
      `${home}/go/src`,
    ];
    const seenInodes = new Set<number>();
    const matches: string[] = [];
    for (const root of searchRoots) {
      const candidate = `${root}/${folderName}`;
      try {
        const st = statSync(candidate);
        if (st.isDirectory() && !seenInodes.has(st.ino)) {
          seenInodes.add(st.ino);
          matches.push(candidate);
        }
      } catch { /* skip */ }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ matches }));
    return true;
  }

  // POST /api/spaces — create space
  if (url === "/api/spaces" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { name, repoPath } = JSON.parse(body);
        const space = spaceService.createSpace({ name, repoPath });
        res.writeHead(201, { "Content-Type": "application/json" });
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

  // GET /api/spaces/:id  and  DELETE /api/spaces/:id
  const spaceIdMatch = url.match(/^\/api\/spaces\/([^/]+)$/);
  if (spaceIdMatch && req.method === "GET") {
    const space = spaceService.getSpace(spaceIdMatch[1]);
    if (!space) { res.writeHead(404); res.end("Space not found"); return true; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(space));
    return true;
  }
  if (spaceIdMatch && req.method === "DELETE") {
    try {
      spaceService.deleteSpace(spaceIdMatch[1]);
      res.writeHead(204);
      res.end();
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // GET /api/spaces/:id/paths — list folders for a space
  const spacePathsMatch = url.match(/^\/api\/spaces\/([^/]+)\/paths$/);
  if (spacePathsMatch && req.method === "GET") {
    try {
      const paths = spaceService.getPaths(spacePathsMatch[1]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ paths }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // POST /api/spaces/:id/paths — add a folder to a space
  if (spacePathsMatch && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer | string) => (body += chunk));
    req.on("end", () => {
      try {
        const { path } = JSON.parse(body);
        if (!path) throw new Error("path is required");
        const resolved = spaceService.addPath(spacePathsMatch[1], path);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ path: resolved }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    return true;
  }

  // DELETE /api/spaces/:id/paths — remove a folder from a space
  if (spacePathsMatch && req.method === "DELETE") {
    let body = "";
    req.on("data", (chunk: Buffer | string) => (body += chunk));
    req.on("end", () => {
      try {
        const { path } = JSON.parse(body);
        if (!path) throw new Error("path is required");
        spaceService.removePath(spacePathsMatch[1], path);
        res.writeHead(204);
        res.end();
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    return true;
  }

  // POST /api/spaces/:id/scan
  const spaceScanMatch = url.match(/^\/api\/spaces\/([^/]+)\/scan$/);
  if (spaceScanMatch && req.method === "POST") {
    spaceService.scanSpace(spaceScanMatch[1]).then((result) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    }).catch((err: Error) => {
      const status = err.message.includes("already in progress") ? 409 : 400;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    });
    return true;
  }

  return false;
}
