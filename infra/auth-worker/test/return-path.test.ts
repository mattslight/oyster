import { describe, it, expect } from "vitest";
import { validateReturnPath } from "../src/return-path";

describe("validateReturnPath — accepts share-viewer paths", () => {
  it("accepts /p/<token> with alphanumerics", () => {
    expect(validateReturnPath("/p/abc123")).toBe("/p/abc123");
  });

  it("accepts /p/<token> with - and _ in the token", () => {
    expect(validateReturnPath("/p/AaBb_-_-9")).toBe("/p/AaBb_-_-9");
  });
});

describe("validateReturnPath — rejects everything else", () => {
  it("returns null for null/undefined/empty", () => {
    expect(validateReturnPath(null)).toBeNull();
    expect(validateReturnPath(undefined)).toBeNull();
    expect(validateReturnPath("")).toBeNull();
  });

  it("rejects /p/ with no token", () => {
    expect(validateReturnPath("/p/")).toBeNull();
  });

  it("rejects /p/<token>/raw — viewer chrome only, never the iframe endpoint", () => {
    expect(validateReturnPath("/p/abc123/raw")).toBeNull();
  });

  it("rejects /p/<token> with a query string", () => {
    expect(validateReturnPath("/p/abc?x=1")).toBeNull();
  });

  it("rejects /p/<token> with a fragment", () => {
    expect(validateReturnPath("/p/abc#h")).toBeNull();
  });

  it("rejects path traversal", () => {
    expect(validateReturnPath("/p/../etc/passwd")).toBeNull();
    expect(validateReturnPath("/p/abc/../../x")).toBeNull();
  });

  it("rejects absolute URLs", () => {
    expect(validateReturnPath("https://attacker.com/p/abc")).toBeNull();
    expect(validateReturnPath("//attacker.com/p/abc")).toBeNull();
    expect(validateReturnPath("javascript:alert(1)")).toBeNull();
  });

  it("rejects unrelated paths", () => {
    expect(validateReturnPath("/dashboard")).toBeNull();
    expect(validateReturnPath("/auth/sign-in")).toBeNull();
    expect(validateReturnPath("/")).toBeNull();
  });

  it("rejects overly long inputs (defence against slow regex)", () => {
    const long = "/p/" + "a".repeat(2048);
    expect(validateReturnPath(long)).toBeNull();
  });
});
