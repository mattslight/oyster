// Access dispatch for the public viewer.
// Spec: docs/superpowers/specs/2026-05-03-r5-viewer-design.md (Access dispatch).

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
      const cookieValue = readCookie(req, `oyster_view_${shareToken}`);
      if (!cookieValue) return { kind: "gate", row };
      const ok = await verifyViewerCookie(cookieValue, shareToken, env.VIEWER_COOKIE_SECRET);
      if (!ok) return { kind: "gate", row };
      return { kind: "ok", row };
    }

    case "signin": {
      const session = await resolveSession(req, env);
      if (!session) {
        return { kind: "redirect", location: `https://oyster.to/auth/sign-in?return=/p/${shareToken}` };
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
