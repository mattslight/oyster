import { describe, it, expect, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { applySchema } from "./fixtures/seed.js";

describe("oyster-cloud worker bootstrap", () => {
  beforeAll(async () => {
    await applySchema();
  });

  it("returns 200 for /health", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("returns 404 for unmatched paths", async () => {
    const res = await SELF.fetch("https://example.com/api/anything");
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("D1 binding is wired (smoke check via users table existence)", async () => {
    const { results } = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='users'`,
    ).all<{ name: string }>();
    expect(results?.[0]?.name).toBe("users");
  });
});
