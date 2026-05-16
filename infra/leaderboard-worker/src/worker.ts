// Oyster Rocket Ship leaderboard worker
//
// GET  /api/leaderboard            → { list: [{ initials, score, created_at }, ...] }   (top 10)
// POST /api/leaderboard            → { ok: true, list: [...] }                          (after insert)
//   body: { initials: string (1-3 chars), score: integer > 0 }
//
// Ranking: score DESC, created_at ASC (oldest wins ties).
// Initials are constrained to A-Z, 0-9, . - (3 chars max) — matches the
// arcade entry UI in docs/rocket-ship.html.

export interface Env {
  DB: D1Database;
}

const ALLOWED_ORIGINS = new Set(["https://oyster.to", "https://www.oyster.to"]);
const INITIALS_RE = /^[A-Z0-9.\-]{1,3}$/;
// Realistic ceiling on a hand-flown rocket. Anything higher is obvious tampering.
const MAX_SCORE = 999;
const TOP_N = 10;
// Soft cap to keep the table bounded — prune rows ranked beyond this on insert.
const RETAIN_N = 100;

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // wrangler dev / local UAT
  return origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:");
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

async function topN(db: D1Database, n: number) {
  const { results } = await db
    .prepare(
      // Ranking order matches the client comparator: highest score first;
      // among equals, the oldest entry (earliest created_at) ranks higher.
      "SELECT initials, score, created_at FROM scores ORDER BY score DESC, created_at ASC LIMIT ?"
    )
    .bind(n)
    .all<{ initials: string; score: number; created_at: number }>();
  return results ?? [];
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/api/leaderboard") return new Response("Not found", { status: 404 });

    const origin = req.headers.get("origin");
    // For mutating verbs we REQUIRE an allowed origin — a missing/empty
    // header (curl, server-to-server) is rejected so writes can't bypass
    // the allowlist. GET stays lenient so the page can fetch on load
    // (simple navigations don't always send Origin).
    const isMutation = req.method === "POST" || req.method === "OPTIONS";
    if (isMutation) {
      if (!isAllowedOrigin(origin)) return new Response("Forbidden", { status: 403 });
    } else if (origin !== null && !isAllowedOrigin(origin)) {
      return new Response("Forbidden", { status: 403 });
    }
    const corsHeaders: Record<string, string> = origin
      ? { "access-control-allow-origin": origin, "vary": "origin" }
      : {};

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "86400",
        },
      });
    }

    if (req.method === "GET") {
      try {
        const list = await topN(env.DB, TOP_N);
        return json({ list }, 200, corsHeaders);
      } catch (err) {
        console.error("d1_select_failed", err);
        return json({ error: "storage_failed" }, 500, corsHeaders);
      }
    }

    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    let payload: { initials?: unknown; score?: unknown };
    try {
      payload = await req.json();
    } catch {
      return json({ error: "invalid_json" }, 400, corsHeaders);
    }

    const initials =
      typeof payload.initials === "string" ? payload.initials.trim().toUpperCase() : "";
    if (!INITIALS_RE.test(initials)) {
      return json({ error: "invalid_initials" }, 400, corsHeaders);
    }
    const score =
      typeof payload.score === "number" && Number.isFinite(payload.score)
        ? Math.floor(payload.score)
        : NaN;
    if (!Number.isFinite(score) || score <= 0 || score > MAX_SCORE) {
      return json({ error: "invalid_score" }, 400, corsHeaders);
    }

    const created_at = Date.now();
    const ip_country = req.headers.get("cf-ipcountry") ?? null;
    const user_agent = (req.headers.get("user-agent") ?? "").slice(0, 256);

    try {
      await env.DB
        .prepare(
          "INSERT INTO scores (initials, score, created_at, ip_country, user_agent) VALUES (?, ?, ?, ?, ?)"
        )
        .bind(initials, score, created_at, ip_country, user_agent)
        .run();
      // Prune rows ranked below RETAIN_N so the table can't grow without
      // bound under spam. We keep more than TOP_N so brief abuse spikes
      // don't immediately evict legitimate entries.
      await env.DB
        .prepare(
          `DELETE FROM scores WHERE id NOT IN (
             SELECT id FROM scores ORDER BY score DESC, created_at ASC LIMIT ?
           )`
        )
        .bind(RETAIN_N)
        .run();
      // Return the freshly-recomputed top-10 so the client can sync without
      // a second round-trip.
      const list = await topN(env.DB, TOP_N);
      return json({ ok: true, list }, 200, corsHeaders);
    } catch (err) {
      console.error("d1_insert_failed", err);
      return json({ error: "storage_failed" }, 500, corsHeaders);
    }
  },
};
