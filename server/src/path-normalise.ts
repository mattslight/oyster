import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

// Single point of truth for how Oyster canonicalises a filesystem path before
// storing it on a source row or comparing it against a session's cwd. Used by
// addSource, updateSource, and the watcher's cwd resolution so all three sides
// of the binding triangle agree on what "the same path" means.
//
// realpathSync collapses symlinks and resolves macOS case-folding to the
// filesystem's canonical casing. If the path doesn't exist (unmounted drive,
// renamed folder we haven't recorded yet) we fall through to a plain resolve()
// — existence is advisory in the rest of the binding layer, so we shouldn't
// reject here either. Callers that need a stricter "must exist" check can
// statSync the result themselves.
//
// Cross-platform: the longest-prefix matching SQL uses literal substr
// comparison against `path` and `cwd`, which only works if both sides use
// the same separator. We normalise to forward slashes here so a Windows
// source.path of `C:/Users/foo` matches a session whose cwd was
// canonicalised to `C:/Users/foo/bar`. The watcher runs incoming
// `tracker.cwd` through this same helper before persisting to
// `sessions.cwd`, so the comparison stays consistent on both sides.
export function normaliseSourcePath(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("Path must be a non-empty string");
  }
  const expanded = raw.startsWith("~/")
    ? resolve(homedir(), raw.slice(2))
    : raw === "~"
      ? homedir()
      : raw;
  const abs = resolve(expanded);
  let canonical: string;
  try {
    canonical = realpathSync(abs);
  } catch {
    canonical = abs;
  }
  // Forward-slash everything so the LIKE-prefix SQL works on Windows too.
  canonical = canonical.replace(/\\/g, "/");
  if (canonical.length > 1 && canonical.endsWith("/")) {
    canonical = canonical.slice(0, -1);
  }
  if (!isAbsolute(canonical) && !/^[A-Za-z]:\//.test(canonical)) {
    throw new Error(`Path must be absolute: ${raw}`);
  }
  return canonical;
}
