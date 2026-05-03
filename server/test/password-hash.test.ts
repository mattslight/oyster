import { describe, it, expect } from "vitest";
import { hashPassword } from "../src/password-hash.js";

describe("hashPassword", () => {
  it("returns format pbkdf2$100000$<salt>$<hash>", async () => {
    const h = await hashPassword("hunter2");
    const parts = h.split("$");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("pbkdf2");
    expect(parts[1]).toBe("100000");
    expect(parts[2]).toMatch(/^[A-Za-z0-9_-]+$/);  // base64url salt
    expect(parts[3]).toMatch(/^[A-Za-z0-9_-]+$/);  // base64url hash
  });

  it("uses a different salt each call (so identical plaintexts hash differently)", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
  });

  it("rejects empty plaintext", async () => {
    await expect(hashPassword("")).rejects.toThrow();
  });
});
