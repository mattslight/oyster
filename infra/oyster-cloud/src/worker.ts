import { jsonError } from "./json.js";
import type { Env } from "./session.js";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Routes for this worker land in Tasks 6 and 7. For now, anything
    // that isn't matched returns 404. Health-check responds 200 for
    // deployment smoke-tests.
    if (url.pathname === "/health" && req.method === "GET") {
      return new Response("ok", { status: 200 });
    }

    void env; // referenced here so TS is satisfied; routes will use it in Tasks 6–7
    return jsonError(404, "not_found");
  },
};
