// /api/auth/* — extracted from index.ts. Three endpoints, all
// local-origin only (sign-in flow exposes user identity).
//
// The auth provider itself (magic-link send + verify, OAuth start +
// callback) lives in the Cloudflare Worker at infra/auth-worker/. These
// server-side routes are just the local glue: who am I, start a sign-in
// (returns the device-flow URL the UI opens), sign me out.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthService } from "../auth-service.js";
import type { RouteCtx } from "../http-utils.js";

export interface AuthRouteDeps {
  authService: AuthService;
}

export async function tryHandleAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: RouteCtx,
  deps: AuthRouteDeps,
): Promise<boolean> {
  const { sendJson, rejectIfNonLocalOrigin } = ctx;
  const { authService } = deps;

  if (url === "/api/auth/whoami" && req.method === "GET") {
    if (rejectIfNonLocalOrigin()) return true;
    const state = authService.getState();
    sendJson({ user: state.user });
    return true;
  }

  if (url === "/api/auth/login" && req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return true;
    try {
      const result = await authService.startSignIn();
      sendJson(result);
    } catch (err) {
      console.error("[auth] /api/auth/login failed:", err);
      sendJson({ error: "auth_unavailable" }, 503);
    }
    return true;
  }

  if (url === "/api/auth/logout" && req.method === "POST") {
    if (rejectIfNonLocalOrigin()) return true;
    try {
      await authService.signOut();
      sendJson({ ok: true });
    } catch (err) {
      console.error("[auth] /api/auth/logout failed:", err);
      sendJson({ error: "logout_failed" }, 500);
    }
    return true;
  }

  return false;
}
