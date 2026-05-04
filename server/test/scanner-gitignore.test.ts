import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGitignore } from "../src/space-service.js";

describe("loadGitignore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oyster-gitignore-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no .gitignore exists", () => {
    expect(loadGitignore(dir)).toBeNull();
  });

  it("returns null for an empty .gitignore", () => {
    writeFileSync(join(dir, ".gitignore"), "");
    expect(loadGitignore(dir)).toBeNull();
  });

  it("matches simple patterns", () => {
    writeFileSync(join(dir, ".gitignore"), "secrets.txt\nbuild/\n");
    const ig = loadGitignore(dir)!;
    expect(ig.ignores("secrets.txt")).toBe(true);
    expect(ig.ignores("build/")).toBe(true);
    expect(ig.ignores("README.md")).toBe(false);
  });

  it("matches glob patterns including nested paths", () => {
    writeFileSync(join(dir, ".gitignore"), "*.log\nnode_modules/\n");
    const ig = loadGitignore(dir)!;
    expect(ig.ignores("foo.log")).toBe(true);
    expect(ig.ignores("nested/dir/foo.log")).toBe(true);
    expect(ig.ignores("node_modules/")).toBe(true);
    expect(ig.ignores("src/index.ts")).toBe(false);
  });

  it("honors negation patterns", () => {
    writeFileSync(join(dir, ".gitignore"), "*.md\n!README.md\n");
    const ig = loadGitignore(dir)!;
    expect(ig.ignores("notes.md")).toBe(true);
    expect(ig.ignores("README.md")).toBe(false);
  });

  it("ignores comments and blank lines", () => {
    writeFileSync(join(dir, ".gitignore"), "# top comment\n\n*.tmp\n   \n# trailing\n");
    const ig = loadGitignore(dir)!;
    expect(ig.ignores("foo.tmp")).toBe(true);
    expect(ig.ignores("foo.txt")).toBe(false);
  });

  it("returns null on unreadable .gitignore (swallows errors)", () => {
    // .gitignore is a directory rather than a file → readFileSync throws.
    // The helper should swallow and return null rather than blow up the scan.
    mkdirSync(join(dir, ".gitignore"));
    expect(loadGitignore(dir)).toBeNull();
  });
});
