// Oyster auth worker — Cloudflare-native magic-link auth and device-flow
// bridge to the local server at localhost:4444. See docs/plans/auth.md
// for the full design.
//
// PR 1 scaffold: only `GET /auth/whoami` is wired, and it always 401s.
// Magic-link send/verify and the device-flow endpoints land in PR 2 + PR 3.

export interface Env {
  DB: D1Database;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/auth/whoami" && req.method === "GET") {
      // Wired in PR 2 once the session cookie is being set. Until then,
      // the endpoint exists so the deploy is verifiable end-to-end.
      // The throwaway COUNT(*) on users isn't part of the eventual
      // implementation — it's here so the smoke test exercises the D1
      // binding and the applied migration, not just route wiring.
      // PR 2 replaces this body with the real session lookup.
      try {
        await env.DB.prepare("SELECT count(*) FROM users").first();
      } catch (err) {
        console.error("d1_unavailable", err);
        return json({ error: "database_unavailable" }, 503);
      }
      return json({ error: "unauthenticated" }, 401);
    }

    return new Response("Not found", { status: 404 });
  },
};
