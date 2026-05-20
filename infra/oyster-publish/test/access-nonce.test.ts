import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applySchema } from "./fixtures/seed";
import { mintAccessNonce, consumeAccessNonce } from "../src/access-nonce";

beforeEach(async () => {
  await applySchema();
});

describe("access-nonce — mint + consume", () => {
  it("a freshly minted nonce consumes once and only once, and sets consumed_at", async () => {
    const nonce = await mintAccessNonce(env, "tok_a", "user_1");
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);

    expect(await consumeAccessNonce(env, nonce, "tok_a")).toBe(true);

    // Verify the row-level invariant: consumed_at must be populated after
    // the first successful consume. Without this, a hypothetical regression
    // that returns true once then resets consumed_at to null (allowing a
    // replay) would still pass the boolean-only checks below.
    const row = await env.DB.prepare(
      "SELECT consumed_at FROM viewer_access_nonces WHERE nonce = ?",
    ).bind(nonce).first<{ consumed_at: number | null }>();
    expect(row?.consumed_at).not.toBeNull();

    expect(await consumeAccessNonce(env, nonce, "tok_a")).toBe(false);
  });

  it("consume with a wrong share_token returns false AND leaves the row unconsumed", async () => {
    // Regression for the atomic-share_token-in-WHERE invariant. If consume
    // updates before asserting the share_token, the row is burned and the
    // legitimate consumption against tok_a would then fail.
    const nonce = await mintAccessNonce(env, "tok_a", "user_1");
    expect(await consumeAccessNonce(env, nonce, "tok_b")).toBe(false);

    const row = await env.DB.prepare(
      "SELECT consumed_at FROM viewer_access_nonces WHERE nonce = ?",
    ).bind(nonce).first<{ consumed_at: number | null }>();
    expect(row?.consumed_at).toBeNull();

    expect(await consumeAccessNonce(env, nonce, "tok_a")).toBe(true);
  });

  it("an expired nonce cannot be consumed", async () => {
    const nonce = await mintAccessNonce(env, "tok_a", "user_1");
    // Force-expire the row.
    await env.DB.prepare(
      "UPDATE viewer_access_nonces SET expires_at = ? WHERE nonce = ?",
    ).bind(Date.now() - 1, nonce).run();
    expect(await consumeAccessNonce(env, nonce, "tok_a")).toBe(false);
  });

  it("a never-minted nonce cannot be consumed", async () => {
    expect(await consumeAccessNonce(env, "no-such-nonce-1234567x", "tok_a")).toBe(false);
  });

  it("mint opportunistically deletes expired rows", async () => {
    const stale = await mintAccessNonce(env, "tok_a", "user_1");
    await env.DB.prepare(
      "UPDATE viewer_access_nonces SET expires_at = ? WHERE nonce = ?",
    ).bind(Date.now() - 1, stale).run();

    await mintAccessNonce(env, "tok_b", "user_2");  // triggers cleanup

    const stillThere = await env.DB.prepare(
      "SELECT 1 AS x FROM viewer_access_nonces WHERE nonce = ?",
    ).bind(stale).first<{ x: number }>();
    expect(stillThere).toBeNull();
  });
});
