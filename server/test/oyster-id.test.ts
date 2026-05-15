import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidUuid, readOysterId } from "../src/oyster-id.js";

function makeTmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "oyster-id-test-")));
}

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

describe("readOysterId", () => {
  let dir: string;
  beforeEach(() => { dir = makeTmp(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns { status: 'missing' } when no .oyster directory exists", () => {
    const result = readOysterId(dir);
    expect(result).toEqual({ status: "missing" });
  });

  it("returns { status: 'valid', id } when .oyster/id contains a valid UUID", () => {
    mkdirSync(join(dir, ".oyster"));
    writeFileSync(join(dir, ".oyster", "id"), "4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f\n", "utf8");
    const result = readOysterId(dir);
    expect(result).toEqual({ status: "valid", id: "4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f" });
  });

  it("accepts a UUID without trailing newline", () => {
    mkdirSync(join(dir, ".oyster"));
    writeFileSync(join(dir, ".oyster", "id"), "4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f", "utf8");
    const result = readOysterId(dir);
    expect(result).toEqual({ status: "valid", id: "4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f" });
  });

  it("returns { status: 'malformed' } when .oyster/id contains non-UUID content", () => {
    mkdirSync(join(dir, ".oyster"));
    writeFileSync(join(dir, ".oyster", "id"), "not a uuid\n", "utf8");
    const result = readOysterId(dir);
    expect(result.status).toBe("malformed");
    if (result.status === "malformed") expect(result.value).toBe("not a uuid");
  });

  it("returns { status: 'blocked' } when .oyster exists as a regular file", () => {
    writeFileSync(join(dir, ".oyster"), "stop", "utf8");
    const result = readOysterId(dir);
    expect(result).toEqual({ status: "blocked", reason: ".oyster-is-file" });
  });

  it("returns { status: 'missing' } when .oyster exists as a directory but id file is missing", () => {
    mkdirSync(join(dir, ".oyster"));
    const result = readOysterId(dir);
    expect(result).toEqual({ status: "missing" });
  });

  it("returns { status: 'unreadable' } when .oyster/id has no read permission", () => {
    // Skip on Windows where chmod is a no-op
    if (process.platform === "win32") return;
    mkdirSync(join(dir, ".oyster"));
    writeFileSync(join(dir, ".oyster", "id"), "4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f", "utf8");
    chmodSync(join(dir, ".oyster", "id"), 0o000);
    const result = readOysterId(dir);
    // Restore so the afterEach cleanup can rm it
    chmodSync(join(dir, ".oyster", "id"), 0o644);
    expect(result.status).toBe("unreadable");
  });
});
