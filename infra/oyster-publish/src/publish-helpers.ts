// Pure helpers for oyster-publish. No D1, no R2, no Workers globals beyond
// crypto.getRandomValues / atob — safe to unit-test under any runtime.

import type { PublishMetadata } from "./types";

export const CAPS = {
  free: {
    max_active: 5,
    max_size_bytes: 10 * 1024 * 1024,
    allowed_modes: ["open", "signin"] as readonly PublishMode[],
  },
  pro: {
    max_active: 100,
    max_size_bytes: 100 * 1024 * 1024,
    allowed_modes: ["open", "password", "signin"] as readonly PublishMode[],
  },
} as const;

export type Tier = keyof typeof CAPS;
export type PublishMode = "open" | "password" | "signin";

export function generateShareToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

export function r2KeyFor(ownerUserId: string, shareToken: string): string {
  return `published/${ownerUserId}/${shareToken}`;
}

export function parseMetadataHeader(blob: string): PublishMetadata {
  let json: string;
  try {
    json = base64urlDecodeToString(blob);
  } catch {
    throw new Error("invalid_metadata");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("invalid_metadata");
  }

  if (!raw || typeof raw !== "object") throw new Error("invalid_metadata");
  const r = raw as Record<string, unknown>;

  if (typeof r.artifact_id !== "string" || r.artifact_id.length === 0) throw new Error("invalid_metadata");
  if (typeof r.artifact_kind !== "string" || r.artifact_kind.length === 0) throw new Error("invalid_metadata");
  if (r.mode !== "open" && r.mode !== "password" && r.mode !== "signin") throw new Error("invalid_metadata");
  if (r.password_hash !== undefined && typeof r.password_hash !== "string") throw new Error("invalid_metadata");

  return {
    artifact_id: r.artifact_id,
    artifact_kind: r.artifact_kind,
    mode: r.mode,
    password_hash: r.password_hash as string | undefined,
  };
}

function base64urlEncode(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  const b64 = btoa(str);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Match /p/<token> or /p/<token>/raw. Returns null on no match.
const SHARE_TOKEN_CHARSET = /^[A-Za-z0-9_-]+$/;
export function parseShareTokenPath(pathname: string): { shareToken: string; raw: boolean } | null {
  if (!pathname.startsWith("/p/")) return null;
  const rest = pathname.slice("/p/".length);
  if (rest.length === 0) return null;
  if (rest.endsWith("/raw")) {
    const token = rest.slice(0, -"/raw".length);
    if (!SHARE_TOKEN_CHARSET.test(token)) return null;
    return { shareToken: token, raw: true };
  }
  if (!SHARE_TOKEN_CHARSET.test(rest)) return null;
  return { shareToken: rest, raw: false };
}

// Kinds whose artifact bytes are served via /raw inside a sandboxed iframe.
// Used in both handleViewerRaw (to 404 non-iframe kinds) and renderForRow
// (to dispatch to renderChromeWithIframe). Keep in sync — single source of truth.
export const IFRAME_KINDS: ReadonlySet<string> = new Set(["app", "deck", "wireframe", "table", "map"]);

// Mirror of auth-worker's isLocalHost helper. Omit Secure on loopback so
// wrangler dev (http://localhost:8787) can exercise the password-unlock flow.
export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" ||
    host.startsWith("localhost:") || host.startsWith("127.0.0.1:");
}

function base64urlDecodeToString(s: string): string {
  // Restore standard base64 padding/alphabet for atob.
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const decoded = atob(padded);
  // atob returns a "binary string" (one char per byte). For UTF-8 JSON we need
  // to round-trip through bytes → TextDecoder.
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
