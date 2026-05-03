import { describe, it, expect } from "vitest";
import { signViewerCookie, verifyViewerCookie } from "../src/viewer-cookie";

const SECRET = "test-secret-do-not-use-in-prod";
const TOKEN = "abc123_-XYZ";

describe("signViewerCookie / verifyViewerCookie — round-trip", () => {
  it("a freshly-signed cookie verifies", async () => {
    const cookie = await signViewerCookie(TOKEN, SECRET);
    const ok = await verifyViewerCookie(cookie, TOKEN, SECRET);
    expect(ok).toBe(true);
  });

  it("the cookie format is `<token>.<timestamp>.<hmac>`", async () => {
    const cookie = await signViewerCookie(TOKEN, SECRET);
    const parts = cookie.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(TOKEN);
    expect(parts[1]).toMatch(/^\d+$/);
    expect(parts[2]).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
  });
});

describe("verifyViewerCookie — rejection", () => {
  it("rejects malformed cookie", async () => {
    expect(await verifyViewerCookie("garbage", TOKEN, SECRET)).toBe(false);
    expect(await verifyViewerCookie("a.b", TOKEN, SECRET)).toBe(false);
    expect(await verifyViewerCookie("a.b.c.d", TOKEN, SECRET)).toBe(false);
  });

  it("rejects when the embedded token doesn't match expected", async () => {
    const cookie = await signViewerCookie(TOKEN, SECRET);
    expect(await verifyViewerCookie(cookie, "different_token", SECRET)).toBe(false);
  });

  it("rejects when the HMAC has been tampered with", async () => {
    const cookie = await signViewerCookie(TOKEN, SECRET);
    const tampered = cookie.slice(0, -1) + (cookie.slice(-1) === "A" ? "B" : "A");
    expect(await verifyViewerCookie(tampered, TOKEN, SECRET)).toBe(false);
  });

  it("rejects when the timestamp has been tampered with", async () => {
    const cookie = await signViewerCookie(TOKEN, SECRET);
    const [token, , hmac] = cookie.split(".");
    const forged = `${token}.0.${hmac}`;
    expect(await verifyViewerCookie(forged, TOKEN, SECRET)).toBe(false);
  });

  it("rejects when verified with a different secret", async () => {
    const cookie = await signViewerCookie(TOKEN, SECRET);
    expect(await verifyViewerCookie(cookie, TOKEN, "other-secret")).toBe(false);
  });

  it("rejects cookies older than 24h (TTL = 86400 seconds)", async () => {
    // Hand-craft an old cookie by signing with a forged timestamp.
    // We use the internal sign function exposed via signViewerCookieAt for tests.
    const { signViewerCookieAt } = await import("../src/viewer-cookie");
    const oldTs = Math.floor(Date.now() / 1000) - 86401;
    const cookie = await signViewerCookieAt(TOKEN, SECRET, oldTs);
    expect(await verifyViewerCookie(cookie, TOKEN, SECRET)).toBe(false);
  });

  it("accepts cookies just under the TTL boundary", async () => {
    const { signViewerCookieAt } = await import("../src/viewer-cookie");
    const recentTs = Math.floor(Date.now() / 1000) - 86399;
    const cookie = await signViewerCookieAt(TOKEN, SECRET, recentTs);
    expect(await verifyViewerCookie(cookie, TOKEN, SECRET)).toBe(true);
  });
});
