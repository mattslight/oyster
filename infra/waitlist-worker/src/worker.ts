// Oyster waitlist worker
//
// POST /api/waitlist  { email: string, source?: string }
//   → 200 { ok: true } on success or already-subscribed
//   → 400 { error } on invalid input
//   → 500 { error } on storage failure
//
// Confirmation email is fired-and-forgotten via ctx.waitUntil after
// we've already returned the response.

export interface Env {
  DB: D1Database;
  RESEND_API_KEY?: string;
  FROM_ADDRESS?: string; // defaults to matt@oyster.to
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SOURCE_LEN = 64;
const ALLOWED_ORIGINS = new Set(["https://oyster.to", "https://www.oyster.to"]);

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // wrangler dev runs on localhost — allow any localhost / 127.0.0.1 origin
  return origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:");
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/api/waitlist") return new Response("Not found", { status: 404 });

    const origin = req.headers.get("origin");
    if (!isAllowedOrigin(origin)) {
      return new Response("Forbidden", { status: 403 });
    }
    const corsHeaders = {
      "access-control-allow-origin": origin!,
      "vary": "origin",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "86400",
        },
      });
    }
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

    let payload: { email?: unknown; source?: unknown };
    try {
      payload = await req.json();
    } catch {
      return json({ error: "invalid_json" }, 400, corsHeaders);
    }

    const rawEmail = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(rawEmail) || rawEmail.length > 254) {
      return json({ error: "invalid_email" }, 400, corsHeaders);
    }

    const source =
      typeof payload.source === "string" ? payload.source.slice(0, MAX_SOURCE_LEN) : "unknown";
    const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 256);
    const ipCountry = req.headers.get("cf-ipcountry") ?? null;
    const now = Date.now();

    let inserted = false;
    try {
      const result = await env.DB
        .prepare(
          "INSERT OR IGNORE INTO waitlist (email, joined_at, source, ip_country, user_agent) VALUES (?, ?, ?, ?, ?)"
        )
        .bind(rawEmail, now, source, ipCountry, userAgent)
        .run();
      inserted = (result.meta?.changes ?? 0) > 0;
    } catch (err) {
      console.error("d1_insert_failed", err);
      return json({ error: "storage_failed" }, 500, corsHeaders);
    }

    // Only send the confirmation when a new row was actually inserted —
    // re-submitting the same email is a quiet no-op (no double email,
    // no leak of which addresses are already on the list).
    if (inserted && env.RESEND_API_KEY) {
      ctx.waitUntil(sendConfirmation(rawEmail, env.RESEND_API_KEY, env.FROM_ADDRESS ?? "matt@oyster.to"));
    }

    return json({ ok: true }, 200, corsHeaders);
  },
};

async function sendConfirmation(email: string, apiKey: string, from: string): Promise<void> {
  const subject = "You’re on the Oyster Pro waitlist";
  const text =
    "Thanks for joining — you'll hear from me when Oyster Pro is ready.\n\n" +
    "That's the only email you'll get from this list. No newsletter or marketing.\n\n" +
    "— Matt";
  const html =
    `<p>Thanks for joining — you'll hear from me when Oyster Pro is ready.</p>` +
    `<p>That's the only email you'll get from this list. No newsletter or marketing.</p>` +
    `<p>— Matt</p>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: `Matt at Oyster <${from}>`,
        to: email,
        subject,
        text,
        html,
      }),
    });
    if (!res.ok) {
      console.error("resend_failed", res.status, await res.text().catch(() => ""));
    }
  } catch (err) {
    console.error("resend_threw", err);
  }
}
