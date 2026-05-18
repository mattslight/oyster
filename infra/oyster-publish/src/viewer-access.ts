// Access dispatch for the public viewer.
// Spec: docs/superpowers/specs/2026-05-03-r5-viewer-design.md (Access dispatch)
//       docs/superpowers/specs/2026-05-18-viewer-access-redirect-design.md
//
// `oyster_view_<token>` is treated as a generic recent-access proof for
// the artefact: any successful gate-clearing path (password POST,
// owner-via-nonce, signin-via-nonce) mints it, and both password and
// signin modes accept it.
//
// The `consumeNonce` option on resolveViewerAccess is REQUIRED on every
// call site so that /raw cannot accidentally start consuming nonces
// without a deliberate edit. /p passes true, /raw and the password POST
// pass false.

import { resolveSession } from "./worker";
import { verifyViewerCookie } from "./viewer-cookie";
import { consumeAccessNonce } from "./access-nonce";
import type { Env, PublicationRow } from "./types";

export type ViewerAccess =
  | { kind: "ok"; row: PublicationRow }
  | { kind: "ok_via_nonce"; row: PublicationRow }
  | { kind: "gate"; row: PublicationRow; error?: "wrong_password" }
  | { kind: "redirect"; location: string }
  | { kind: "gone"; row: PublicationRow }
  | { kind: "not_found" };

export interface ResolveOptions {
  /**
   * When true, a valid `?key=<nonce>` consumes the nonce and yields
   * `ok_via_nonce`. When false, the `?key=` parameter is ignored entirely
   * (the caller is responsible for any cookie-based check). /p MUST pass
   * true; /raw and the password POST handler MUST pass false. Making the
   * flag required prevents a future regression from silently turning the
   * iframe endpoint into a nonce-consuming endpoint.
   */
  consumeNonce: boolean;
}

export async function resolveViewerAccess(
  req: Request,
  env: Env,
  shareToken: string,
  opts: ResolveOptions,
): Promise<ViewerAccess> {
  // Step 1: row lookup.
  const row = await env.DB.prepare(
    "SELECT * FROM published_artifacts WHERE share_token = ?",
  ).bind(shareToken).first<PublicationRow>();
  if (!row) return { kind: "not_found" };

  // Step 2: gone check.
  if (row.unpublished_at !== null && row.unpublished_at !== undefined) {
    return { kind: "gone", row };
  }

  // Step 3: nonce pre-check (caller opt-in). Open mode never needs a
  // nonce — the viewer would serve content anyway. Invalid / expired /
  // wrong-share nonces fall through silently — no oracle.
  if (opts.consumeNonce && (row.mode === "password" || row.mode === "signin")) {
    const key = new URL(req.url).searchParams.get("key");
    if (key && await consumeAccessNonce(env, key, shareToken)) {
      return { kind: "ok_via_nonce", row };
    }
  }

  // Step 4: mode dispatch.
  switch (row.mode) {
    case "open":
      return { kind: "ok", row };

    case "password": {
      if (await hasValidViewerCookie(req, shareToken, env.VIEWER_COOKIE_SECRET)) {
        return { kind: "ok", row };
      }
      return { kind: "gate", row };
    }

    case "signin": {
      if (await hasValidViewerCookie(req, shareToken, env.VIEWER_COOKIE_SECRET)) {
        return { kind: "ok", row };
      }
      const session = await resolveSession(req, env);
      if (!session) {
        return {
          kind: "redirect",
          location: `https://oyster.to/api/publish/access-redirect/${shareToken}`,
        };
      }
      return { kind: "ok", row };
    }

    default:
      return { kind: "not_found" };
  }
}

export function readCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get("Cookie");
  if (!cookie) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
  return m && m[1] ? m[1] : null;
}

async function hasValidViewerCookie(
  req: Request,
  shareToken: string,
  secret: string,
): Promise<boolean> {
  const value = readCookie(req, `oyster_view_${shareToken}`);
  if (!value) return false;
  return await verifyViewerCookie(value, shareToken, secret);
}
