import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SpaceService } from "./space-service.js";
import { slugify } from "./utils.js";
import { isContainer, discoverCandidates, groupWithLLM } from "./discovery.js";

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
    const home = process.env.HOME || homedir();
    if (!home) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Cannot determine home directory" }));
      return true;
    }
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

  // POST /api/spaces/from-folder — convert a folder group into a space
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

  // POST /api/discover — scan a folder, detect if container, return candidates + suggestions
  if (url === "/api/discover" && req.method === "POST") {
    const discoverOrigin = req.headers.origin;
    if (discoverOrigin && !discoverOrigin.startsWith("http://localhost") && !discoverOrigin.startsWith("http://127.0.0.1")) {
      res.writeHead(403);
      res.end("Forbidden");
      return true;
    }
    let body = "";
    req.on("data", (chunk: Buffer | string) => (body += chunk));
    req.on("end", () => {
      try {
        const { path: rawPath } = JSON.parse(body);
        if (!rawPath) throw new Error("path is required");
        const folderPath = rawPath.startsWith("~/")
          ? resolve(join(homedir(), rawPath.slice(2)))
          : resolve(rawPath);

        if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
          throw new Error("Path does not exist or is not a directory");
        }

        const container = isContainer(folderPath);
        if (!container) {
          // Single project — return as-is, no grouping needed
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ container: false, path: folderPath }));
          return;
        }

        const candidates = discoverCandidates(folderPath);
        // Start LLM grouping
        groupWithLLM(candidates).then(suggestions => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ container: true, candidates, suggestions }));
        }).catch(err => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        });
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    return true;
  }

  // POST /api/discover/import — batch create spaces from confirmed suggestions
  if (url === "/api/discover/import" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer | string) => (body += chunk));
    req.on("end", async () => {
      try {
        const { spaces: spaceList } = JSON.parse(body) as {
          spaces: Array<{ name: string; folders: string[] }>
        };
        if (!spaceList?.length) throw new Error("spaces array is required");

        const results: Array<{ spaceId: string; name: string; scanned: number }> = [];

        for (const s of spaceList) {
          // "__home__" = import without a space, scan into home
          const isHome = s.name === "__home__";
          let spaceId = "home";

          if (!isHome) {
            let space;
            try {
              space = spaceService.createSpace({ name: s.name });
            } catch {
              space = spaceService.getSpace(s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""));
              if (!space) throw new Error(`Could not create or find space "${s.name}"`);
            }
            spaceId = space.id;

            for (const folder of s.folders) {
              try {
                spaceService.addPath(spaceId, folder);
              } catch { /* path might already be added */ }
            }
          }

          // Scan — for home, add paths temporarily then scan
          if (isHome) {
            // Ensure home space exists
            try { spaceService.createSpace({ name: "home" }); } catch {}
            for (const folder of s.folders) {
              try { spaceService.addPath("home", folder); } catch {}
            }
          }

          const scanResult = await spaceService.scanSpace(spaceId);
          results.push({
            spaceId,
            name: isHome ? "home" : s.name,
            scanned: scanResult.discovered + scanResult.resurfaced,
          });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ imported: results }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    return true;
  }

  return false;
}
