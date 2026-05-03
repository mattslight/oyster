// oyster-publish — R5 publish endpoints + viewer scaffold.
// All real handler bodies land in Phase 2 (#315 PR 2).

import type { Env } from "./types";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // POST /api/publish/upload
    if (url.pathname === "/api/publish/upload" && req.method === "POST") {
      return notImplemented("publish_upload");
    }

    // DELETE /api/publish/:share_token
    if (url.pathname.startsWith("/api/publish/") && req.method === "DELETE") {
      return notImplemented("publish_unpublish");
    }

    // GET /p/:share_token — viewer body lands in #316.
    if (url.pathname.startsWith("/p/") && req.method === "GET") {
      return notImplemented("publish_viewer");
    }

    return new Response("Not Found", { status: 404 });
  },
};

function notImplemented(handler: string): Response {
  return new Response(
    JSON.stringify({ error: "not_implemented", handler }),
    { status: 501, headers: { "content-type": "application/json" } },
  );
}
