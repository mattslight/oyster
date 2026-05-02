import { describe, it, expect } from "vitest";
import { pkceVerifier, codeChallengeS256, pickPrimaryVerifiedEmail } from "../src/oauth-helpers";

describe("pkceVerifier", () => {
  it("is 43 base64url characters (32 bytes, no padding)", () => {
    const v = pkceVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("produces a different value on each call", () => {
    const a = pkceVerifier();
    const b = pkceVerifier();
    expect(a).not.toBe(b);
  });
});

describe("codeChallengeS256", () => {
  // Reference vector from RFC 7636 Appendix B.
  it("matches the RFC 7636 example", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await codeChallengeS256(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("is 43 base64url characters", async () => {
    const challenge = await codeChallengeS256(pkceVerifier());
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("pickPrimaryVerifiedEmail", () => {
  it("returns the primary && verified entry, lowercased", () => {
    const result = pickPrimaryVerifiedEmail([
      { email: "Other@Example.com", primary: false, verified: true, visibility: null },
      { email: "Main@Example.com", primary: true, verified: true, visibility: "public" },
    ]);
    expect(result).toBe("main@example.com");
  });

  it("returns null when primary is unverified", () => {
    const result = pickPrimaryVerifiedEmail([
      { email: "main@example.com", primary: true, verified: false, visibility: null },
      { email: "other@example.com", primary: false, verified: true, visibility: null },
    ]);
    expect(result).toBeNull();
  });

  it("returns null when no primary entry exists", () => {
    const result = pickPrimaryVerifiedEmail([
      { email: "a@example.com", primary: false, verified: true, visibility: null },
      { email: "b@example.com", primary: false, verified: true, visibility: null },
    ]);
    expect(result).toBeNull();
  });

  it("returns null on an empty array", () => {
    expect(pickPrimaryVerifiedEmail([])).toBeNull();
  });

  it("ignores entries with missing fields", () => {
    const result = pickPrimaryVerifiedEmail([
      { email: "main@example.com", primary: true, verified: true, visibility: null },
      { email: "broken@example.com" } as never,
    ]);
    expect(result).toBe("main@example.com");
  });
});
