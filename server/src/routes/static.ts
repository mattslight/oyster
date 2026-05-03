// Static file + system info routes — extracted from index.ts.
//
// Buckets:
//   GET /api/resolve-path           URL→filesystem resolver
//   GET /api/workspace              resolved Oyster paths (Vault page)
//   GET /api/vault/inventory        cached vault summary
//   GET /api/apps/:name/start       managed-app runtime: start
//   GET /api/apps/:name/stop        managed-app runtime: stop
//   GET /docs/:name                 server-rendered docs (md/mmd → html)
//   GET /artifacts/<rel>            static asset serving for artifact bundles
//
// resolveArtifactsUrl lives here too — only the static routes use it now.

import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { ArtifactService } from "../artifact-service.js";
import type { SqliteSpaceStore } from "../space-store.js";
import type { RouteCtx } from "../http-utils.js";
import { MIME } from "../mime.js";
import { renderMarkdown, renderMermaid } from "../renderers.js";
import { injectBridge } from "../error-bridge.js";
import { inferName } from "../artifact-detector.js";
import {
  getVaultInventory,
  type VaultInventoryLayout,
} from "../vault-inventory.js";

export interface StaticRouteDeps {
  artifactService: ArtifactService;
  spaceStore: SqliteSpaceStore;
  db: Database.Database;
  layout: VaultInventoryLayout & { backupsDir: string };
  /** App runtime hooks. Defined in opencode-orphan-sweep / process-manager
   *  but injected here so the route module doesn't pull in the whole
   *  app-lifecycle subsystem. */
  startApp: (name: string, config: { command: string; cwd: string; port: number }) => void;
  stopApp: (name: string, port: number) => boolean;
  isPortOpen: (port: number) => Promise<boolean>;
  waitForReady: (port: number) => Promise<void>;
}

/** Resolve a /artifacts/<relativePath> URL to a file on disk. The icon
 *  resolver in artifact-service emits URLs like /artifacts/<folder>/icon.png
 *  using just the folder name (the artifact's bundle dir), so this handler
 *  has to try every place that folder could live after #207:
 *
 *    OYSTER_HOME/<rel>          dedicated icons/<id>/ + legacy flat
 *    APPS_DIR/<rel>             installed bundles (builtins + community)
 *    SPACES_DIR/<rel>           <rel> starts with a space name
 *    SPACES_DIR/<space>/<rel>   AI-generated bundles whose URL is just
 *                               /artifacts/<bundle>/icon.png with no hint
 *
 *  Containment guard uses resolve()+sep — a raw startsWith would let
 *  "/Users/me/OysterX/..." pass when OYSTER_HOME is "/Users/me/Oyster". */
export function resolveArtifactsUrl(
  relativePath: string,
  layout: { oysterHome: string; appsDir: string; spacesDir: string },
): string | null {
  const root = resolve(layout.oysterHome);
  const isInsideRoot = (candidate: string): boolean => {
    const r = resolve(candidate);
    return r === root || r.startsWith(root + sep);
  };
  // Only return regular files — a directory match would propagate
  // through to readFileSync upstream and crash with EISDIR. statSync
  // throws on missing, so wrap in a single try/catch.
  const isFile = (p: string): boolean => {
    try { return statSync(p).isFile(); } catch { return false; }
  };
  const fixedCandidates = [
    join(layout.oysterHome, relativePath),
    join(layout.appsDir, relativePath),
    join(layout.spacesDir, relativePath),
  ];
  for (const candidate of fixedCandidates) {
    if (!isInsideRoot(candidate)) continue;
    if (isFile(candidate)) return candidate;
  }
  const firstSegment = relativePath.split("/")[0];
  if (!firstSegment || firstSegment === "icons") return null;
  try {
    for (const spaceName of readdirSync(layout.spacesDir)) {
      const candidate = join(layout.spacesDir, spaceName, relativePath);
      if (isInsideRoot(candidate) && isFile(candidate)) return candidate;
    }
  } catch { /* SPACES_DIR might not exist on a fresh install */ }
  return null;
}

export async function tryHandleStaticRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: RouteCtx,
  deps: StaticRouteDeps,
): Promise<boolean> {
  const { sendJson, sendError, rejectIfNonLocalOrigin } = ctx;
  const { artifactService, spaceStore, db, layout } = deps;

  // GET /api/resolve-path?url=… — leaks absolute filesystem paths, so
  // local-origin only.
  if (url.startsWith("/api/resolve-path")) {
    if (rejectIfNonLocalOrigin()) return true;
    let targetUrl: string;
    try {
      targetUrl = new URL(url, "http://localhost").searchParams.get("url") || "";
    } catch {
      sendJson({ error: "Invalid URL" }, 400);
      return true;
    }

    let filePath: string | undefined;
    const docsMatch = targetUrl.match(/^\/docs\/([^/]+)$/);
    if (docsMatch) {
      filePath = artifactService.getDocFile(docsMatch[1]);
    }
    if (!filePath && targetUrl.startsWith("/artifacts/")) {
      const relativePath = targetUrl.slice("/artifacts/".length).split("?")[0];
      const resolved = resolveArtifactsUrl(relativePath, layout);
      if (resolved) filePath = resolved;
    }

    sendJson({ filePath: filePath || null });
    return true;
  }

  // GET /api/workspace — the resolved Oyster workspace layout, used by
  // the "Where do my files live?" builtin so it shows this user's actual
  // paths (respects OYSTER_USERLAND + dev vs installed). Local-origin
  // gated — paths are user-private.
  if (url === "/api/workspace") {
    if (rejectIfNonLocalOrigin()) return true;
    sendJson({
      oysterHome: layout.oysterHome,
      paths: {
        db: layout.dbDir,
        apps: layout.appsDir,
        spaces: layout.spacesDir,
        backups: layout.backupsDir,
      },
      platform: process.platform,
      spaces: (() => {
        try {
          return readdirSync(layout.spacesDir).filter((e) => {
            try { return statSync(join(layout.spacesDir, e)).isDirectory(); } catch { return false; }
          });
        } catch { return []; }
      })(),
    });
    return true;
  }

  // GET /api/vault/inventory — what's currently in the user's ~/Oyster
  // root: file count + on-disk size for each top-level subdir. Powers
  // the Vault info page so users can see what cloud sync (when it ships)
  // will be backing up. Local-origin only — surfaces filesystem layout.
  if (url === "/api/vault/inventory" && req.method === "GET") {
    if (rejectIfNonLocalOrigin()) return true;
    try {
      sendJson(getVaultInventory({ layout, db, spaceStore }));
    } catch (err) {
      sendError(err, 500);
    }
    return true;
  }

  // GET /api/apps/:name/start
  // Local-origin gated — these mutate process state. Still GETs for
  // backward compat with the existing web client (web/src/data/artifacts-api
  // calls these as fetch() with no method); migrating to POST is a
  // separate, coordinated change that updates the client at the same time.
  const startMatch = url.match(/^\/api\/apps\/([^/]+)\/start$/);
  if (startMatch) {
    if (rejectIfNonLocalOrigin()) return true;
    const name = startMatch[1];
    const config = artifactService.getAppConfig(name);
    if (!config) {
      res.writeHead(404);
      res.end("Unknown app");
      return true;
    }
    if (await deps.isPortOpen(config.port)) {
      sendJson({ status: "already_running" });
      return true;
    }
    deps.startApp(name, config);
    try {
      await deps.waitForReady(config.port);
      sendJson({ status: "started", port: config.port });
    } catch {
      sendJson({ status: "timeout" }, 500);
    }
    return true;
  }

  // GET /api/apps/:name/stop — see /start above re: local-origin guard +
  // GET-vs-POST.
  const stopMatch = url.match(/^\/api\/apps\/([^/]+)\/stop$/);
  if (stopMatch) {
    if (rejectIfNonLocalOrigin()) return true;
    const name = stopMatch[1];
    const config = artifactService.getAppConfig(name);
    if (!config) {
      res.writeHead(404);
      res.end("Unknown app");
      return true;
    }
    const stopped = deps.stopApp(name, config.port);
    sendJson({ status: stopped ? "stopped" : "not_managed" });
    return true;
  }

  // GET /docs/:name — server-rendered docs (md/mmd → HTML; otherwise raw).
  // Local-origin gated — serves user-private artifact content.
  const docsMatch = url.split("?")[0].match(/^\/docs\/([^/]+)$/);
  if (docsMatch) {
    if (rejectIfNonLocalOrigin()) return true;
    const name = docsMatch[1];
    const filePath = artifactService.getDocFile(name);
    if (!filePath) {
      res.writeHead(404);
      res.end("Not found");
      return true;
    }
    const ext = extname(filePath);
    const mime = MIME[ext] || "application/octet-stream";
    // existsSync + readFileSync is a TOCTOU race — wrap the read so a
    // file removed between check and read returns 404 instead of crashing.
    try {
      if (ext === ".md") {
        const content = readFileSync(filePath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(renderMarkdown(name, content));
      } else if (ext === ".mmd" || ext === ".mermaid") {
        const content = readFileSync(filePath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(injectBridge(renderMermaid(name, content)));
      } else {
        res.writeHead(200, { "Content-Type": mime });
        res.end(readFileSync(filePath));
      }
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
    return true;
  }

  // GET /artifacts/<rel> — static asset serving for artifact bundles.
  // Uses resolveArtifactsUrl (above) so this stays in sync with the
  // /api/resolve-path helper. Walker enforces the path-traversal guard
  // (must stay under OYSTER_HOME) and the isFile() check (no directory
  // matches → no EISDIR crash). Local-origin gated — serves user files.
  if (url.startsWith("/artifacts/")) {
    if (rejectIfNonLocalOrigin()) return true;
    const urlPath = url.split("?")[0];
    const relativePath = urlPath.slice("/artifacts/".length);
    const filePath = resolveArtifactsUrl(relativePath, layout);

    if (!filePath) {
      res.writeHead(404);
      res.end("Not found");
      return true;
    }

    const ext = extname(filePath);
    const mime = MIME[ext] || "application/octet-stream";
    // Wrap reads — the resolver checked existence + isFile, but a file
    // can be removed/renamed between resolution and read (TOCTOU).
    try {
      if (ext === ".md") {
        const content = readFileSync(filePath, "utf8");
        const name = inferName(filePath);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(injectBridge(renderMarkdown(name, content)));
      } else if (ext === ".mmd" || ext === ".mermaid") {
        const content = readFileSync(filePath, "utf8");
        const name = inferName(filePath);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(injectBridge(renderMermaid(name, content)));
      } else if (ext === ".html" || ext === ".htm") {
        const raw = readFileSync(filePath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(injectBridge(raw));
      } else {
        res.writeHead(200, { "Content-Type": mime });
        res.end(readFileSync(filePath));
      }
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
    return true;
  }

  return false;
}
