// Access dispatch for the public viewer.
// Spec: docs/superpowers/specs/2026-05-03-r5-viewer-design.md (Access dispatch)
//       docs/superpowers/specs/2026-05-18-viewer-access-redirect-design.md
//
// `oyster_view_<token>` is treated as a generic recent-access proof for
// the artefact: any successful gate-clearing path (password POST,
// owner-via-nonce, signin-via-nonce) mints it, and both password and
// signin modes accept it. Without that semantics, the post-nonce
// clean-URL follow-up GET in signin mode would loop back to access-
// redirect because the apex session is not visible on share.oyster.to.

import { resolveSession } from "./worker";
import { verifyViewerCookie } from "./viewer-cookie";
import type { Env, PublicationRow } from "./types";

export type ViewerAccess =
  | { kind: "ok"; row: PublicationRow }
  | { kind: "gate"; row: PublicationRow; error?: "wrong_password" }
  | { kind: "redirect"; location: string }
  | { kind: "gone"; row: PublicationRow }
  | { kind: "not_found" };

export async function resolveViewerAccess(
  req: Request,
  env: Env,
  shareToken: string,
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

  // Step 3: mode dispatch.
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
      // Honour the viewer cookie as a generic recent-access proof. The
      // apex `oyster_session` is host-only on oyster.to and is NOT
      // visible on share.oyster.to in production (auth-worker #397), so
      // resolveSession() returns null in the cross-host case — the
      // cookie is the only access proof we'll see on this host.
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
      // Unreachable per the D1 CHECK constraint, but typescript-safe.
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
