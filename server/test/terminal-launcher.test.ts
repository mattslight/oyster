// Tests for `resolveClaudeBinary` and `buildLaunchArgs`. Pure helpers, so
// covered with focused unit tests rather than full route exercising.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClaudeBinary, buildLaunchArgs } from "../src/terminal-launcher.js";

describe("buildLaunchArgs", () => {
  it("returns --session-id <uuid> for claude_new with a freshly generated UUID", () => {
    const result = buildLaunchArgs("claude_new");
    expect(result.args[0]).toBe("--session-id");
    expect(result.args[1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(result.sessionId).toBe(result.args[1]);
  });

  it("generates a fresh UUID on every call", () => {
    const a = buildLaunchArgs("claude_new");
    const b = buildLaunchArgs("claude_new");
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it("returns --resume <id> for claude_resume and echoes the sessionId", () => {
    const result = buildLaunchArgs("claude_resume", "abc-123");
    expect(result.args).toEqual(["--resume", "abc-123"]);
    expect(result.sessionId).toBe("abc-123");
  });

  it("throws when claude_resume is called without a sessionId", () => {
    expect(() => buildLaunchArgs("claude_resume")).toThrow();
  });
});

describe("resolveClaudeBinary", () => {
  let dir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oyster-claude-bin-"));
    originalEnv = process.env.OYSTER_CLAUDE_BIN;
    delete process.env.OYSTER_CLAUDE_BIN;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.OYSTER_CLAUDE_BIN;
    else process.env.OYSTER_CLAUDE_BIN = originalEnv;
  });

  it("respects OYSTER_CLAUDE_BIN when set and the path exists", () => {
    const fakeBin = join(dir, "fake-claude");
    writeFileSync(fakeBin, "#!/bin/sh\necho fake", "utf8");
    chmodSync(fakeBin, 0o755);
    process.env.OYSTER_CLAUDE_BIN = fakeBin;
    const result = resolveClaudeBinary(dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(fakeBin);
  });

  it("finds a binary at node_modules/.bin/claude under the package root", () => {
    const binDir = join(dir, "server", "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const bin = join(binDir, process.platform === "win32" ? "claude.cmd" : "claude");
    writeFileSync(bin, "#!/bin/sh\necho fake", "utf8");
    chmodSync(bin, 0o755);
    const result = resolveClaudeBinary(dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(bin);
  });

  // Note: we don't unit-test the PATH `which` branch — it depends on the
  // host environment and Cgi shells. The route-level integration test covers
  // the binary_not_found error code returned to clients.
});
