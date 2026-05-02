// Per-request response helpers, factored out of index.ts so route modules
// (routes/*.ts) can write responses without inlining sendJson / sendError /
// readJsonBody / rejectIfNonLocalOrigin twenty-plus times.
//
// `makeRouteCtx(req, res)` returns helpers that close over the request and
// response. One context per request — Node already allocates req/res per
// connection, so the extra closure cost is negligible.

import type { IncomingMessage, ServerResponse } from "node:http";

/** Throwable that carries an HTTP status — lets readJsonBody and others
 *  surface a specific status (e.g. 413) without writing the response
 *  themselves, which would race the caller's own catch-block response. */
export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}

/** Mutation endpoints only accept tiny config bodies ({label, group_name}
 *  etc). Cap at 64 KB to prevent memory/CPU abuse from oversized payloads. */
export const MAX_MUTATION_BODY = 64_000;

export interface RouteCtx {
  /** Send a JSON response. Default status 200. */
  sendJson: (data: unknown, status?: number) => void;
  /** Send an error envelope `{error: message}`. HttpError carries its own
   *  status; everything else falls back to the supplied default (400). */
  sendError: (err: unknown, fallback?: number) => void;
  /** Read and parse a JSON request body. Throws HttpError(413) if it
   *  exceeds MAX_MUTATION_BODY, HttpError(400) if it isn't valid JSON. */
  readJsonBody: () => Promise<Record<string, unknown>>;
  /** Refuse callers from non-loopback origins. Sets the CORS allow-origin
   *  to the request's origin on success. Returns true if the request was
   *  rejected (caller should `return` immediately). */
  rejectIfNonLocalOrigin: () => boolean;
}

export function makeRouteCtx(req: IncomingMessage, res: ServerResponse): RouteCtx {
  const sendJson = (data: unknown, status = 200): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  const sendError = (err: unknown, fallback = 400): void => {
    if (err instanceof HttpError) sendJson({ error: err.message }, err.status);
    else sendJson({ error: err instanceof Error ? err.message : String(err) }, fallback);
  };

  async function readJsonBody(): Promise<Record<string, unknown>> {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_MUTATION_BODY) {
        // Destroy the socket so we stop reading further bytes from an
        // oversized payload — unlike a plain throw, which lets the rest
        // of the stream keep draining. Matches the /api/import/* pattern.
        req.destroy();
        throw new HttpError("Payload too large", 413);
      }
    }
    if (!body) return {};
    try { return JSON.parse(body) as Record<string, unknown>; }
    catch { throw new HttpError("Invalid JSON body", 400); }
  }

  // Artifact endpoints (both reads and mutations) are localhost-only. A
  // browser tab on some other site could otherwise fetch user data or
  // trigger destructive actions via http://localhost:<port>/api/…. Mirrors
  // the /mcp handler pattern: reject non-local origins outright; echo the
  // origin back for local ones to override the wildcard CORS header set
  // by the top-level handler.
  const rejectIfNonLocalOrigin = (): boolean => {
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      sendJson({ error: "Forbidden origin" }, 403);
      return true;
    }
    if (!origin) {
      const remote = req.socket.remoteAddress || "";
      const isLoopback =
        remote === "127.0.0.1" ||
        remote === "::1" ||
        remote === "::ffff:127.0.0.1";
      if (!isLoopback) {
        sendJson({ error: "Forbidden — non-local origin" }, 403);
        return true;
      }
    }
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    return false;
  };

  return { sendJson, sendError, readJsonBody, rejectIfNonLocalOrigin };
}
