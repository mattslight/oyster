// Unit tests for normaliseSourcePath — the single point of truth for how
// every path that enters the binding layer (source.path, watcher cwd) is
// canonicalised. These tests lock in the edge cases the PR review surfaced:
// relative paths are rejected, drive roots aren't stripped to invalid
// forms, separator normalisation happens, and ~ expansion works.

import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { normaliseSourcePath } from "../src/path-normalise.js";

describe("normaliseSourcePath", () => {
  it("rejects empty input", () => {
    expect(() => normaliseSourcePath("")).toThrow(/non-empty/);
  });

  it("rejects relative paths (would otherwise silently absolutise to cwd)", () => {
    expect(() => normaliseSourcePath("foo/bar")).toThrow(/absolute/);
    expect(() => normaliseSourcePath("./foo")).toThrow(/absolute/);
    expect(() => normaliseSourcePath("../sibling")).toThrow(/absolute/);
  });

  it("accepts absolute posix paths", () => {
    // Use a path we can be confident exists or doesn't — either way
    // normaliseSourcePath returns a canonical absolute string.
    const result = normaliseSourcePath("/tmp/oyster-test-path-that-may-not-exist");
    expect(result.startsWith("/")).toBe(true);
  });

  it("expands ~/ via homedir", () => {
    const result = normaliseSourcePath("~/some-folder");
    expect(result.startsWith(homedir().replace(/\\/g, "/"))).toBe(true);
    expect(result.endsWith("/some-folder")).toBe(true);
  });

  it("expands ~ on its own to homedir", () => {
    expect(normaliseSourcePath("~")).toBe(homedir().replace(/\\/g, "/"));
  });

  it("strips trailing slash on a non-root path", () => {
    expect(normaliseSourcePath("/tmp/some-folder/")).toBe("/tmp/some-folder");
  });

  it("preserves posix root '/'", () => {
    // realpathSync('/') succeeds on macOS/Linux; the trim must NOT strip
    // the single slash and leave an empty string.
    expect(normaliseSourcePath("/")).toBe("/");
  });

  // Windows-specific paths can only meaningfully roundtrip through
  // normaliseSourcePath on a Windows host (path.resolve uses the
  // platform's path semantics). On posix `resolve('C:\\foo')` treats the
  // input as relative and prepends cwd, which masks what we're trying to
  // verify. Skip those assertions off-Windows but keep the wiring so a
  // Windows CI run catches the regressions.
  const onWindows = process.platform === "win32";
  it.skipIf(!onWindows)("preserves a Windows drive root after slash normalisation", () => {
    expect(normaliseSourcePath("C:\\")).toBe("C:/");
  });

  it.skipIf(!onWindows)("converts Windows separators to forward slashes", () => {
    expect(normaliseSourcePath("C:\\Users\\matt\\repo")).toBe("C:/Users/matt/repo");
  });
});
