import { describe, it, expect } from "vitest";
import { isValidUuid } from "../src/oyster-id.js";

describe("isValidUuid", () => {
  it("accepts a canonical lowercase v4 UUID", () => {
    expect(isValidUuid("4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f")).toBe(true);
  });
  it("rejects uppercase letters (we canonicalise to lowercase)", () => {
    expect(isValidUuid("4A7C9D2E-1B3F-4D5A-9C8E-6F2A1B3D4E5F")).toBe(false);
  });
  it("rejects malformed strings", () => {
    expect(isValidUuid("")).toBe(false);
    expect(isValidUuid("not a uuid")).toBe(false);
    expect(isValidUuid("4a7c9d2e1b3f4d5a9c8e6f2a1b3d4e5f")).toBe(false); // no hyphens
    expect(isValidUuid("4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5")).toBe(false); // too short
  });
  it("rejects non-strings", () => {
    expect(isValidUuid(null as unknown as string)).toBe(false);
    expect(isValidUuid(123 as unknown as string)).toBe(false);
  });
});
