// Regression: signin-mode handoff across the oyster.to / share.oyster.to
// cookie boundary.
//
// Production reality: the auth-worker sets `oyster_session` host-only on
// oyster.to (no Domain=), so browsers DO NOT send it to share.oyster.to.
// Tests in viewer-handler.test.ts that forge the cookie onto a
// share.oyster.to request hide this — they bypass the host-scoping the
// browser would enforce.
//
// This file models the real behaviour: cookies on oyster.to vs not on
// share.oyster.to, and asserts:
//   (a) without the access-redirect, signin mode is a closed loop, and
//   (b) with the access-redirect, the visitor can reach content.

import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import { applySchema, seedUser, seedActiveOpenWithBody } from "./fixtures/seed";

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (env as any).VIEWER_PASSWORD_LIMIT = { limit: async () => ({ success: true }) };
});

beforeEach(async () => {
  await applySchema();
});

function req(absUrl: string, opts: { cookie?: string } = {}): Request {
  const headers = new Headers();
  if (opts.cookie) headers.set("Cookie", opts.cookie);
  return new Request(absUrl, { method: "GET", headers });
}

async function call(r: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(r, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("signin mode across the oyster.to / share.oyster.to cookie boundary", () => {
  it("direct signin-mode visit to share.oyster.to without apex cookie → redirect to access-redirect", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art_loop1", body: "# private",
    });
    await env.DB.prepare("UPDATE published_artifacts SET mode = 'signin' WHERE share_token = ?")
      .bind(shareToken).run();

    // Real browser: would NOT send oyster.to-host-only cookie to share.oyster.to.
    const res = await call(req(`https://share.oyster.to/p/${shareToken}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location"))
      .toBe(`https://oyster.to/api/publish/access-redirect/${shareToken}`);
  });

  it("oyster.to/p/<token> 308s to share.oyster.to even with an apex session — loop is real", async () => {
    // Demonstrates that the cookie boundary is enforced by the worker's
    // own legacy-origin 308: even though oyster.to/p sees the cookie,
    // the redirect strips the host and the next hop is share.oyster.to,
    // where the cookie cannot follow. Combined with the previous test,
    // this is the closed loop that existed before access-redirect.
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art_loop2", body: "# private",
    });
    await env.DB.prepare("UPDATE published_artifacts SET mode = 'signin' WHERE share_token = ?")
      .bind(shareToken).run();

    const res = await call(req(`https://oyster.to/p/${shareToken}`, {
      cookie: `oyster_session=${u.sessionToken}`,
    }));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`https://share.oyster.to/p/${shareToken}`);
  });

  it("access-redirect on oyster.to sees the apex session and produces a working cross-host handoff", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art_loop3", body: "# private content",
    });
    await env.DB.prepare("UPDATE published_artifacts SET mode = 'signin' WHERE share_token = ?")
      .bind(shareToken).run();

    // Step 1: oyster.to sees the apex cookie (host-only on oyster.to).
    const step1 = await call(req(
      `https://oyster.to/api/publish/access-redirect/${shareToken}`,
      { cookie: `oyster_session=${u.sessionToken}` },
    ));
    expect(step1.status).toBe(302);
    const handoff = new URL(step1.headers.get("location")!);
    expect(handoff.origin + handoff.pathname).toBe(`https://share.oyster.to/p/${shareToken}`);
    const nonce = handoff.searchParams.get("key");
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);

    // Step 2: share.oyster.to consumes the nonce — NO apex cookie sent
    // here, matching real browser cookie scoping.
    const step2 = await call(req(handoff.toString()));
    expect(step2.status).toBe(302);
    expect(step2.headers.get("location")).toBe(`/p/${shareToken}`);
    const setCookie = step2.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`oyster_view_${shareToken}=`);
    const cookieValue = setCookie.match(/oyster_view_[^=]+=([^;]+)/)?.[1] ?? "";

    // Step 3: clean URL follow-up — still no apex cookie, only the
    // recent-access proof — must serve content.
    const step3 = await call(req(`https://share.oyster.to/p/${shareToken}`, {
      cookie: `oyster_view_${shareToken}=${cookieValue}`,
    }));
    expect(step3.status).toBe(200);
    expect(await step3.text()).toContain("private content");
  });
});
