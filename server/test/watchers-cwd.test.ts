// pickJsonlCwd unit tests — recovers the local cwd for a jsonl file by
// matching the file's parent-dir encoding against candidate cwds from the
// events inside. Critical for cross-device resume: after Device B resumes
// a Device A session, the jsonl's early events have Device A's cwd, but the
// file lives at Device B's encoded path on disk. Old behaviour (take the
// first ev.cwd) poisoned the sessions row with the origin device's cwd
// and broke pushBytes forever after.
import { describe, it, expect } from "vitest";
import { pickJsonlCwd } from "../src/watchers/claude-code.js";

describe("pickJsonlCwd", () => {
  it("returns null when no candidates", () => {
    const path = "/Users/me/.claude/projects/-Users-me-proj/abc.jsonl";
    expect(pickJsonlCwd(path, [])).toBeNull();
  });

  it("returns null when no candidate encodes to the dir name", () => {
    // File is in `-Users-me-proj` but candidates are all foreign cwds.
    const path = "/Users/me/.claude/projects/-Users-me-proj/abc.jsonl";
    const candidates = ["C:\\Users\\matth", "/home/foo"];
    expect(pickJsonlCwd(path, candidates)).toBeNull();
  });

  it("returns the only matching candidate", () => {
    const path = "/Users/me/.claude/projects/-Users-me-proj/abc.jsonl";
    expect(pickJsonlCwd(path, ["/Users/me/proj"])).toBe("/Users/me/proj");
  });

  it("returns the LAST matching candidate (so user-renames / cwd-changes win over stale early events)", () => {
    const path = "/Users/me/.claude/projects/-Users-me-proj/abc.jsonl";
    // Two events with the same effective cwd — could happen if a session
    // touches a sibling working tree mid-session. We take the later one.
    const candidates = ["/Users/me/proj", "/Users/me/proj"];
    expect(pickJsonlCwd(path, candidates)).toBe("/Users/me/proj");
  });

  it("ignores foreign-device cwds and returns the local one (resume scenario)", () => {
    // Mac-resumed Windows session: file lives at Mac encoded path, jsonl
    // head has Windows cwd, Mac events appended later have Mac cwd.
    const path = "/Users/Matthew.Slight/.claude/projects/-Users-Matthew-Slight-Dev-oyster-os/abc.jsonl";
    const candidates = [
      "C:\\Users\\matth",                        // Windows-origin, won't encode to the Mac dir
      "C:\\Users\\matth",
      "/Users/Matthew.Slight/Dev/oyster-os",     // Mac event appended post-resume — matches
    ];
    expect(pickJsonlCwd(path, candidates)).toBe("/Users/Matthew.Slight/Dev/oyster-os");
  });

  it("skips null / undefined entries", () => {
    const path = "/Users/me/.claude/projects/-Users-me-proj/abc.jsonl";
    expect(pickJsonlCwd(path, [null, undefined, "/Users/me/proj", null])).toBe("/Users/me/proj");
  });

  it("handles paths with no parent dir gracefully", () => {
    // Defensive — should never happen in practice but the helper shouldn't crash.
    expect(pickJsonlCwd("abc.jsonl", ["/Users/me/proj"])).toBeNull();
  });
});
