import { describe, it, expect } from "vitest";
import { isClaudeProtocolArtifact } from "../src/utils/claude-protocol-artifacts.js";

describe("isClaudeProtocolArtifact", () => {
  it("matches the three wrapper families", () => {
    expect(isClaudeProtocolArtifact("<command-name>/exit</command-name>")).toBe(true);
    expect(isClaudeProtocolArtifact("<command-message>name</command-message>")).toBe(true);
    expect(isClaudeProtocolArtifact("<command-args></command-args>")).toBe(true);
    expect(isClaudeProtocolArtifact("<local-command-stdout>Goodbye!</local-command-stdout>")).toBe(true);
    expect(isClaudeProtocolArtifact("<local-command-caveat>Caveat: ...</local-command-caveat>")).toBe(true);
    expect(isClaudeProtocolArtifact("<system-reminder>\nThe user named this session ...\n</system-reminder>")).toBe(true);
  });

  it("tolerates leading whitespace (real claude-code indents some variants)", () => {
    expect(isClaudeProtocolArtifact("  \n\t<command-name>/exit</command-name>")).toBe(true);
  });

  it("does not match normal user text", () => {
    expect(isClaudeProtocolArtifact("hello")).toBe(false);
    expect(isClaudeProtocolArtifact("")).toBe(false);
    expect(isClaudeProtocolArtifact("can you fix the bug in src/foo.ts?")).toBe(false);
  });

  it("does not match messages that merely mention the tags inside their body", () => {
    expect(isClaudeProtocolArtifact("here's an example: <command-name>")).toBe(false);
    expect(isClaudeProtocolArtifact("the <system-reminder> tag was confusing")).toBe(false);
  });

  it("does not match assistant slash-command echoes", () => {
    expect(isClaudeProtocolArtifact("/rename OYSTER: fix share iframe popups")).toBe(false);
  });
});
