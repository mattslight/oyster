import { describe, it, expect } from "vitest";
import { generateShareToken, r2KeyFor, CAPS, parseMetadataHeader } from "../src/publish-helpers";

describe("generateShareToken", () => {
  it("is 32 base64url characters (24 bytes, no padding)", () => {
    const t = generateShareToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("produces a different value on each call", () => {
    const a = generateShareToken();
    const b = generateShareToken();
    expect(a).not.toBe(b);
  });
});

describe("r2KeyFor", () => {
  it("composes published/{owner}/{token}", () => {
    expect(r2KeyFor("user_abc", "tok_xyz")).toBe("published/user_abc/tok_xyz");
  });
});

describe("CAPS.free", () => {
  it("max_active is 5", () => {
    expect(CAPS.free.max_active).toBe(5);
  });

  it("max_size_bytes is exactly 10 MB", () => {
    expect(CAPS.free.max_size_bytes).toBe(10 * 1024 * 1024);
  });
});

describe("parseMetadataHeader", () => {
  function encode(payload: object): string {
    const json = JSON.stringify(payload);
    return Buffer.from(json).toString("base64url");
  }

  it("decodes a valid 'open' payload", () => {
    const blob = encode({ artifact_id: "a", artifact_kind: "notes", mode: "open" });
    const result = parseMetadataHeader(blob);
    expect(result).toEqual({ artifact_id: "a", artifact_kind: "notes", mode: "open" });
  });

  it("decodes a 'password' payload with hash", () => {
    const blob = encode({
      artifact_id: "a", artifact_kind: "notes", mode: "password",
      password_hash: "pbkdf2$100000$xx$yy",
    });
    const result = parseMetadataHeader(blob);
    expect(result.mode).toBe("password");
    expect(result.password_hash).toBe("pbkdf2$100000$xx$yy");
  });

  it("throws 'invalid_metadata' for malformed base64url", () => {
    expect(() => parseMetadataHeader("!!! not base64 !!!")).toThrow("invalid_metadata");
  });

  it("throws 'invalid_metadata' for missing required fields", () => {
    const blob = encode({ artifact_id: "a", mode: "open" });
    expect(() => parseMetadataHeader(blob)).toThrow("invalid_metadata");
  });

  it("throws 'invalid_metadata' for invalid mode value", () => {
    const blob = encode({ artifact_id: "a", artifact_kind: "k", mode: "weird" });
    expect(() => parseMetadataHeader(blob)).toThrow("invalid_metadata");
  });
});
