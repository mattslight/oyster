import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import {
  applySchema, seedUser, seedActivePublication, retirePublication,
} from "./fixtures/seed";

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (env as any).VIEWER_PASSWORD_LIMIT = { limit: async () => ({ success: true }) };
});

beforeEach(async () => {
  await applySchema();
});

function getReq(path: string, opts: { cookie?: string } = {}): Request {
  const headers = new Headers();
  if (opts.cookie) headers.set("Cookie", opts.cookie);
  return new Request(`https://oyster.to${path}`, { method: "GET", headers });
}

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const PATH = (t: string) => `/api/publish/access-redirect/${t}`;

describe("GET /api/publish/access-redirect/:token", () => {
  it("returns 404 for an unknown token", async () => {
    const res = await call(getReq(PATH("no-such")));
    expect(res.status).toBe(404);
  });

  it("returns 410 for a retired publication", async () => {
    const u = await seedUser();
    const token = await seedActivePublication({ ownerUserId: u.id, artifactId: "art1", mode: "open" });
    await retirePublication(token);
    const res = await call(getReq(PATH(token)));
    expect(res.status).toBe(410);
  });

  it("open mode → 302 straight to viewer with no key", async () => {
    const u = await seedUser();
    const token = await seedActivePublication({ ownerUserId: u.id, artifactId: "art1", mode: "open" });
    const res = await call(getReq(PATH(token)));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://share.oyster.to/p/${token}`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(new URL(res.headers.get("location")!).searchParams.get("key")).toBeNull();
  });

  it("signin mode + no session → 302 to sign-in with return target", async () => {
    const u = await seedUser();
    const token = await seedActivePublication({ ownerUserId: u.id, artifactId: "art2", mode: "signin" });
    const res = await call(getReq(PATH(token)));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://oyster.to/auth/sign-in");
    expect(loc.searchParams.get("return")).toBe(PATH(token));
  });

  it("signin mode + session → 302 to viewer with a fresh ?key= and a row in viewer_access_nonces", async () => {
    const u = await seedUser();
    const token = await seedActivePublication({ ownerUserId: u.id, artifactId: "art2", mode: "signin" });
    const res = await call(getReq(PATH(token), { cookie: `oyster_session=${u.sessionToken}` }));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(`https://share.oyster.to/p/${token}`);
    const key = loc.searchParams.get("key");
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const row = await env.DB.prepare(
      "SELECT share_token, user_id, consumed_at FROM viewer_access_nonces WHERE nonce = ?",
    ).bind(key).first<{ share_token: string; user_id: string; consumed_at: number | null }>();
    expect(row?.share_token).toBe(token);
    expect(row?.user_id).toBe(u.id);
    expect(row?.consumed_at).toBeNull();
  });

  it("password mode + no session → 302 to sign-in with return target", async () => {
    const u = await seedUser();
    const token = await seedActivePublication({ ownerUserId: u.id, artifactId: "art3", mode: "password" });
    const res = await call(getReq(PATH(token)));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("return")).toBe(PATH(token));
  });

  it("password mode + owner session → 302 to viewer with a fresh ?key=", async () => {
    const owner = await seedUser();
    const token = await seedActivePublication({
      ownerUserId: owner.id, artifactId: "art4", mode: "password",
    });
    const res = await call(getReq(PATH(token), { cookie: `oyster_session=${owner.sessionToken}` }));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(`https://share.oyster.to/p/${token}`);
    expect(loc.searchParams.get("key")).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("password mode + non-owner session → 403 page (no nonce minted)", async () => {
    const owner = await seedUser({ id: "user_owner" });
    const other = await seedUser({ id: "user_other" });
    const token = await seedActivePublication({
      ownerUserId: owner.id, artifactId: "art5", mode: "password",
    });
    const res = await call(getReq(PATH(token), { cookie: `oyster_session=${other.sessionToken}` }));
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    // Body should give them a way back to the public gate.
    expect(await res.text()).toContain(`/p/${token}`);

    // No nonce minted.
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM viewer_access_nonces WHERE share_token = ?",
    ).bind(token).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});
