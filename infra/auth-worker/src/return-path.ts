// Generic post-sign-in redirect target validation for #316.
// Spec: docs/superpowers/specs/2026-05-03-r5-viewer-design.md (Auth-worker change).
//
// The allowlist matches the share-viewer route AND ONLY that route.
// We reject /p/<token>/raw because that's the iframe-content endpoint —
// landing a user there would strand them with no navigation.

const SHARE_VIEWER_PATH = /^\/p\/[A-Za-z0-9_-]+$/;
const MAX_PATH_LEN = 256;  // share_token is 32 chars; this is generous.

export function validateReturnPath(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_PATH_LEN) return null;
  if (!SHARE_VIEWER_PATH.test(raw)) return null;
  return raw;
}
