// Generic post-sign-in redirect target validation for #316 and the
// viewer access redirect (2026-05-18 spec).
//
// Allowlist matches the share-viewer route AND the access-redirect route,
// and nothing else. We reject /p/<token>/raw because that's the iframe-
// content endpoint — landing a user there would strand them with no
// navigation. We reject query strings and fragments so attackers cannot
// smuggle params through the validator.

const SHARE_VIEWER_PATH    = /^\/p\/[A-Za-z0-9_-]+$/;
const ACCESS_REDIRECT_PATH = /^\/api\/publish\/access-redirect\/[A-Za-z0-9_-]+$/;
const MAX_PATH_LEN = 256;

export function validateReturnPath(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_PATH_LEN) return null;
  // JS regex `$` matches before a trailing newline; reject any control
  // chars (especially CR/LF) explicitly so they never reach a Location header.
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;
  if (SHARE_VIEWER_PATH.test(raw) || ACCESS_REDIRECT_PATH.test(raw)) return raw;
  return null;
}
