import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import {
  applySchema, seedUser, seedActivePublication, retirePublication,
  putR2Object, seedActiveOpenWithBody,
} from "./fixtures/seed";
import { signViewerCookie } from "../src/viewer-cookie";
import { mintAccessNonce, consumeAccessNonce } from "../src/access-nonce";

beforeAll(() => {
  // VIEWER_PASSWORD_LIMIT is an unsafe ratelimit binding; miniflare doesn't auto-mock it.
  // Inject a stub that always succeeds so password-mode POST tests can reach the form logic.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (env as any).VIEWER_PASSWORD_LIMIT = { limit: async () => ({ success: true }) };
});

beforeEach(async () => {
  await applySchema();
});

function getReq(path: string, opts: { cookie?: string; ifNoneMatch?: string } = {}): Request {
  const headers = new Headers();
  if (opts.cookie) headers.set("Cookie", opts.cookie);
  if (opts.ifNoneMatch) headers.set("If-None-Match", opts.ifNoneMatch);
  return new Request(`https://share.oyster.to${path}`, { method: "GET", headers });
}

function postReq(path: string, opts: { cookie?: string; password?: string } = {}): Request {
  const headers = new Headers();
  if (opts.cookie) headers.set("Cookie", opts.cookie);
  headers.set("Content-Type", "application/x-www-form-urlencoded");
  const body = new URLSearchParams();
  if (opts.password !== undefined) body.set("password", opts.password);
  return new Request(`https://share.oyster.to${path}`, { method: "POST", headers, body: body.toString() });
}

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("GET/POST /p/:token — legacy origin redirect (#397)", () => {
  it("308s GET oyster.to/p/<token> to share.oyster.to/p/<token>", async () => {
    const req = new Request("https://oyster.to/p/abc123", { method: "GET" });
    const res = await call(req);
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://share.oyster.to/p/abc123");
  });

  it("308s www.oyster.to/p/<token>/raw with query preserved", async () => {
    const req = new Request("https://www.oyster.to/p/abc123/raw?x=1", { method: "GET" });
    const res = await call(req);
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://share.oyster.to/p/abc123/raw?x=1");
  });

  it("308s POST so password-form submissions keep their method+body intact", async () => {
    // 301 would coerce POST→GET in many clients, dropping the password
    // body. 308 is method-preserving, so a stale bookmark that POSTs
    // against the legacy origin still completes its unlock on the new one.
    const req = new Request("https://oyster.to/p/abc123", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "password=hunter2",
    });
    const res = await call(req);
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://share.oyster.to/p/abc123");
  });
});

describe("GET /p/:token — 404 / 410", () => {
  it("returns 404 for unknown token", async () => {
    const res = await call(getReq("/p/no-such-token"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await res.text()).toContain("Share not found");
  });

  it("returns 410 for retired publication", async () => {
    const u = await seedUser();
    const token = await seedActivePublication({ ownerUserId: u.id, artifactId: "art1" });
    await retirePublication(token);
    const res = await call(getReq(`/p/${token}`));
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("This share has been removed");
  });
});

describe("GET /p/:token — open mode", () => {
  it("renders markdown notes with chrome", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art1", artifactKind: "notes",
      contentType: "text/markdown", body: "# Hello world",
    });
    const res = await call(getReq(`/p/${shareToken}`));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Hello world</h1>");
    expect(body).toMatch(/class="brand-mark"/); // chrome present
    expect(body).toContain("Published with");
    expect(body).toContain("https://oyster.to");
  });

  it("sets open-mode cache headers + ETag", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art1", body: "# x",
    });
    const res = await call(getReq(`/p/${shareToken}`));
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
    expect(res.headers.get("etag")).toMatch(/^"[^"]+"$/);
  });

  it("serves images inline with no chrome", async () => {
    const u = await seedUser();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art1", artifactKind: "notes",
      contentType: "image/png", body: png,
    });
    const res = await call(getReq(`/p/${shareToken}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
  });

  it("renders app kind via iframe pointing at /raw", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art1", artifactKind: "app",
      contentType: "text/html", body: "<h1>my app</h1>",
    });
    const res = await call(getReq(`/p/${shareToken}`));
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    const body = await res.text();
    expect(body).toContain(`src="/p/${shareToken}/raw"`);
    expect(body).toContain('sandbox="allow-scripts allow-same-origin"');
  });
});

describe("GET /p/:token/raw — iframe content", () => {
  it("serves bytes with strict CSP", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art1", artifactKind: "app",
      contentType: "text/html", body: "<h1>raw app</h1>",
    });
    const res = await call(getReq(`/p/${shareToken}/raw`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'self' https:");
    expect(csp).toContain("form-action 'none'");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(await res.text()).toContain("<h1>raw app</h1>");
  });

  it("returns 404 for unknown token on /raw", async () => {
    const res = await call(getReq(`/p/no-such-token/raw`));
    expect(res.status).toBe(404);
  });

  it("returns 410 on /raw for retired publication", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art1", artifactKind: "app",
      contentType: "text/html", body: "<h1>x</h1>",
    });
    await retirePublication(shareToken);
    const res = await call(getReq(`/p/${shareToken}/raw`));
    expect(res.status).toBe(410);
  });

  it("returns 404 on /raw for non-iframe kind (notes)", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art1", artifactKind: "notes",
      contentType: "text/markdown", body: "# hello",
    });
    const res = await call(getReq(`/p/${shareToken}/raw`));
    expect(res.status).toBe(404);
  });

  it("returns 200 on /raw for iframe kind (app)", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art1", artifactKind: "app",
      contentType: "text/html", body: "<h1>app</h1>",
    });
    const res = await call(getReq(`/p/${shareToken}/raw`));
    expect(res.status).toBe(200);
  });
});

describe("GET/POST /p/:token — password mode", () => {
  // PBKDF2-SHA256 producer using the same params as server/src/password-hash.ts
  // so the Worker's verifier (Web Crypto) matches.
  async function makeHash(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(password),
      { name: "PBKDF2" }, false, ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
      key, 256,
    );
    const b64url = (b: Uint8Array) => {
      let s = ""; for (const x of b) s += String.fromCharCode(x);
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    return `pbkdf2$100000$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
  }

  it("GET with no cookie → password gate page", async () => {
    const u = await seedUser();
    const hash = await makeHash("letmein");
    const token = await seedActivePublication({
      ownerUserId: u.id, artifactId: "art2", mode: "password", passwordHash: hash,
    });
    const res = await call(getReq(`/p/${token}`));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Password required");
  });

  it("POST correct password → 302 with cookie; follow-up GET → content", async () => {
    const u = await seedUser();
    const hash = await makeHash("letmein");
    const token = await seedActivePublication({
      ownerUserId: u.id, artifactId: "art2", mode: "password", passwordHash: hash,
    });
    // Seed R2 bytes too (the shared seedActivePublication doesn't put bytes).
    await putR2Object(`published/${u.id}/${token}`, "# Secret notes", "text/markdown");
    // Update the row's content_type so renderMarkdownPage is chosen
    await env.DB.prepare(
      "UPDATE published_artifacts SET content_type = 'text/markdown', artifact_kind = 'notes' WHERE share_token = ?",
    ).bind(token).run();

    const postRes = await call(postReq(`/p/${token}`, { password: "letmein" }));
    expect(postRes.status).toBe(302);
    const setCookie = postRes.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`oyster_view_${token}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain(`Path=/p/${token}`);

    // Extract cookie value and follow up with GET.
    const cookieMatch = setCookie.match(new RegExp(`oyster_view_${token}=([^;]+)`));
    expect(cookieMatch).not.toBeNull();
    const cookie = `oyster_view_${token}=${cookieMatch![1]}`;
    const getRes = await call(getReq(`/p/${token}`, { cookie }));
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toContain("Secret notes");
  });

  it("POST correct password on localhost → cookie omits Secure flag", async () => {
    const u = await seedUser();
    const hash = await makeHash("letmein");
    const token = await seedActivePublication({
      ownerUserId: u.id, artifactId: "art2loc", mode: "password", passwordHash: hash,
    });
    const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
    const body = new URLSearchParams({ password: "letmein" });
    const req = new Request(`http://localhost:8787/p/${token}`, { method: "POST", headers, body: body.toString() });
    const postRes = await call(req);
    expect(postRes.status).toBe(302);
    const setCookie = postRes.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`oyster_view_${token}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).not.toContain("Secure");
  });

  it("POST wrong password → 200 gate with 'Incorrect password'", async () => {
    const u = await seedUser();
    const hash = await makeHash("letmein");
    const token = await seedActivePublication({
      ownerUserId: u.id, artifactId: "art2", mode: "password", passwordHash: hash,
    });
    const res = await call(postReq(`/p/${token}`, { password: "WRONG" }));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Password required");
    expect(body).toContain("Incorrect password");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("POST empty password → 200 gate with error", async () => {
    const u = await seedUser();
    const hash = await makeHash("letmein");
    const token = await seedActivePublication({
      ownerUserId: u.id, artifactId: "art2", mode: "password", passwordHash: hash,
    });
    const res = await call(postReq(`/p/${token}`, { password: "" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Incorrect password");
  });

  it("GET with tampered cookie → re-renders gate", async () => {
    const u = await seedUser();
    const hash = await makeHash("letmein");
    const token = await seedActivePublication({
      ownerUserId: u.id, artifactId: "art2", mode: "password", passwordHash: hash,
    });
    const cookie = `oyster_view_${token}=tampered.0.garbage`;
    const res = await call(getReq(`/p/${token}`, { cookie }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Password required");
  });

  it("GET with valid cookie → content (no re-prompt)", async () => {
    const u = await seedUser();
    const hash = await makeHash("letmein");
    const token = await seedActivePublication({
      ownerUserId: u.id, artifactId: "art2", mode: "password", passwordHash: hash,
    });
    await putR2Object(`published/${u.id}/${token}`, "# unlocked", "text/markdown");
    await env.DB.prepare(
      "UPDATE published_artifacts SET content_type = 'text/markdown', artifact_kind = 'notes' WHERE share_token = ?",
    ).bind(token).run();
    const cookieValue = await signViewerCookie(token, env.VIEWER_COOKIE_SECRET);
    const cookie = `oyster_view_${token}=${cookieValue}`;
    const res = await call(getReq(`/p/${token}`, { cookie }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("unlocked");
  });
});

describe("ETag / 304", () => {
  it("returns 304 on matching If-None-Match", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art1", body: "# x",
    });
    const first = await call(getReq(`/p/${shareToken}`));
    const etag = first.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[^"]+"$/);
    const second = await call(getReq(`/p/${shareToken}`, { ifNoneMatch: etag }));
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
  });

  it("does NOT return 304 for password mode", async () => {
    const u = await seedUser();
    const hash = await env.DB.prepare("SELECT 'pbkdf2$100000$x$y' AS h").first<{ h: string }>();
    const token = await seedActivePublication({
      ownerUserId: u.id, artifactId: "art2", mode: "password", passwordHash: hash!.h,
    });
    await putR2Object(`published/${u.id}/${token}`, "# x", "text/markdown");
    await env.DB.prepare(
      "UPDATE published_artifacts SET content_type = 'text/markdown', artifact_kind = 'notes' WHERE share_token = ?",
    ).bind(token).run();
    const cookieValue = await signViewerCookie(token, env.VIEWER_COOKIE_SECRET);
    const cookie = `oyster_view_${token}=${cookieValue}`;
    const res = await call(getReq(`/p/${token}`, { cookie, ifNoneMatch: `"${token}-anything"` }));
    expect(res.status).toBe(200);  // password mode never returns 304
  });
});

describe("GET /p/:token — unknown artifact_kind", () => {
  it("returns 500 for unknown kind with non-text content_type", async () => {
    const u = await seedUser();
    const token = `seeded_${crypto.randomUUID().slice(0, 8)}`;
    const r2Key = `published/${u.id}/${token}`;
    await env.DB.prepare(
      `INSERT INTO published_artifacts
       (share_token, owner_user_id, artifact_id, artifact_kind, mode, password_hash,
        r2_key, content_type, size_bytes, published_at, updated_at, unpublished_at)
       VALUES (?, ?, 'art_unk', 'unknown_kind', 'open', NULL, ?, 'application/octet-stream', 4, ?, ?, NULL)`,
    ).bind(token, u.id, r2Key, Date.now(), Date.now()).run();
    await putR2Object(r2Key, new Uint8Array([0, 1, 2, 3]), "application/octet-stream");
    const res = await call(getReq(`/p/${token}`));
    expect(res.status).toBe(500);
  });
});

describe("GET /p/:token — signin mode", () => {
  it("unsigned visitor → 302 to /api/publish/access-redirect/<token>", async () => {
    const u = await seedUser();
    const token = await seedActivePublication({
      ownerUserId: u.id, artifactId: "art3", mode: "signin",
    });
    const res = await call(getReq(`/p/${token}`));
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toBe(`https://oyster.to/api/publish/access-redirect/${token}`);
  });

  it("signed-in visitor → content", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art3", body: "# private",
    });
    // Flip mode to signin
    await env.DB.prepare("UPDATE published_artifacts SET mode = 'signin' WHERE share_token = ?")
      .bind(shareToken).run();
    const cookie = `oyster_session=${u.sessionToken}`;
    const res = await call(getReq(`/p/${shareToken}`, { cookie }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("private");
  });

  it("signed-in cookie-only visitor (no apex session) → content", async () => {
    // Models the post-nonce-consumption follow-up GET: the viewer cookie
    // was minted by the consume handler, but the apex session cookie was
    // NEVER on share.oyster.to in the first place. Without the signin-mode
    // cookie acceptance change, this would loop back to access-redirect.
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art3cookie", body: "# private",
    });
    await env.DB.prepare("UPDATE published_artifacts SET mode = 'signin' WHERE share_token = ?")
      .bind(shareToken).run();

    const viewerCookie = await signViewerCookie(shareToken, env.VIEWER_COOKIE_SECRET);
    const res = await call(getReq(`/p/${shareToken}`, {
      cookie: `oyster_view_${shareToken}=${viewerCookie}`,  // no oyster_session
    }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("private");
  });
});

describe("GET /p/:token — footer copy is mode-invariant", () => {
  it("open viewer shows 'Published with oyster.to' footer", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art_cta_open", body: "# open",
    });
    const res = await call(getReq(`/p/${shareToken}`));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Published with");
  });

  it("signin viewer (signed in) shows the same 'Published with' footer", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art3cta", body: "# signin-only",
    });
    await env.DB.prepare("UPDATE published_artifacts SET mode = 'signin' WHERE share_token = ?")
      .bind(shareToken).run();
    const cookie = `oyster_session=${u.sessionToken}`;
    const res = await call(getReq(`/p/${shareToken}`, { cookie }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Published with");
  });
});

describe("nonce pre-check — consumeNonce flag", () => {
  it("/p/<token>?key=<valid_nonce> sets viewer cookie, 302s to clean URL, no-referrer", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art_n1", body: "# nonce content",
    });
    await env.DB.prepare("UPDATE published_artifacts SET mode = 'signin' WHERE share_token = ?")
      .bind(shareToken).run();

    const nonce = await mintAccessNonce(env, shareToken, u.id);
    const res = await call(getReq(`/p/${shareToken}?key=${nonce}`));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/p/${shareToken}`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`oyster_view_${shareToken}=`);
    expect(setCookie).toContain(`Path=/p/${shareToken}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");

    // Follow-up GET with the cookie returns content. We pass NO oyster_session
    // here on purpose — the cookie is the only proof on share.oyster.to.
    const cookieValue = setCookie.match(/oyster_view_[^=]+=([^;]+)/)?.[1] ?? "";
    const follow = await call(getReq(`/p/${shareToken}`, {
      cookie: `oyster_view_${shareToken}=${cookieValue}`,
    }));
    expect(follow.status).toBe(200);
    expect(await follow.text()).toContain("nonce content");

    // The nonce is consumed.
    const row = await env.DB.prepare(
      "SELECT consumed_at FROM viewer_access_nonces WHERE nonce = ?",
    ).bind(nonce).first<{ consumed_at: number | null }>();
    expect(row?.consumed_at).not.toBeNull();
  });

  it("/p/<token>/raw?key=<valid_nonce> does NOT consume the nonce", async () => {
    // Regression for the explicit consumeNonce: false on /raw. If a future
    // change drops the flag, this test fails.
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art_n_raw", body: "<h1>iframe</h1>",
      artifactKind: "app", contentType: "text/html",
    });
    await env.DB.prepare("UPDATE published_artifacts SET mode = 'signin' WHERE share_token = ?")
      .bind(shareToken).run();

    const nonce = await mintAccessNonce(env, shareToken, u.id);
    await call(getReq(`/p/${shareToken}/raw?key=${nonce}`));

    const row = await env.DB.prepare(
      "SELECT consumed_at FROM viewer_access_nonces WHERE nonce = ?",
    ).bind(nonce).first<{ consumed_at: number | null }>();
    expect(row?.consumed_at).toBeNull();

    // The nonce remains usable on the proper /p endpoint.
    expect(await consumeAccessNonce(env, nonce, shareToken)).toBe(true);
  });

  it("/p/<token>/raw?key=<valid_nonce> does NOT consume — password mode", async () => {
    // Password mode is the higher-stakes case for the /raw non-consume
    // invariant: it has an owner-bound password and the most surface area.
    // A future regression that started consuming on /raw in password mode
    // would burn the nonce before the outer /p page could use it.
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art_n_raw_pw", body: "<h1>iframe</h1>",
      artifactKind: "app", contentType: "text/html",
    });
    await env.DB.prepare(
      "UPDATE published_artifacts SET mode = 'password', password_hash = 'pbkdf2$100000$AAAA$BBBB' WHERE share_token = ?",
    ).bind(shareToken).run();

    const nonce = await mintAccessNonce(env, shareToken, u.id);
    await call(getReq(`/p/${shareToken}/raw?key=${nonce}`));

    const row = await env.DB.prepare(
      "SELECT consumed_at FROM viewer_access_nonces WHERE nonce = ?",
    ).bind(nonce).first<{ consumed_at: number | null }>();
    expect(row?.consumed_at).toBeNull();

    expect(await consumeAccessNonce(env, nonce, shareToken)).toBe(true);
  });

  it("/p/<token>?key=<nonce_for_other_share> falls through silently AND leaves the nonce unconsumed", async () => {
    const u = await seedUser();
    const tokA = await seedActivePublication({ ownerUserId: u.id, artifactId: "art_A", mode: "signin" });
    const tokB = await seedActivePublication({ ownerUserId: u.id, artifactId: "art_B", mode: "signin" });

    const nonce = await mintAccessNonce(env, tokA, u.id);
    const res = await call(getReq(`/p/${tokB}?key=${nonce}`));
    // signin mode, no cookie/session → 302 to access-redirect (silent fall-through).
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `https://oyster.to/api/publish/access-redirect/${tokB}`,
    );

    // Nonce is still alive for its real share.
    const row = await env.DB.prepare(
      "SELECT consumed_at FROM viewer_access_nonces WHERE nonce = ?",
    ).bind(nonce).first<{ consumed_at: number | null }>();
    expect(row?.consumed_at).toBeNull();
  });

  it("a replayed key falls through to the standard mode dispatch", async () => {
    const u = await seedUser();
    const token = await seedActivePublication({ ownerUserId: u.id, artifactId: "art_replay", mode: "signin" });
    const nonce = await mintAccessNonce(env, token, u.id);

    // First call consumes.
    const first = await call(getReq(`/p/${token}?key=${nonce}`));
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe(`/p/${token}`);

    // Second call with the same (now-consumed) key behaves identically to
    // a no-key request: signin mode, no cookie → 302 to access-redirect.
    const second = await call(getReq(`/p/${token}?key=${nonce}`));
    expect(second.status).toBe(302);
    expect(second.headers.get("location"))
      .toBe(`https://oyster.to/api/publish/access-redirect/${token}`);
  });

  it("does NOT consume the nonce when the visitor already has a valid viewer cookie", async () => {
    // Models a visitor who clicked the access-redirect link earlier (got
    // the cookie), then re-lands on the ?key= URL via back-button /
    // bookmark / cached page. The nonce must NOT be burned.
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art_n_cookie", body: "# content",
    });
    await env.DB.prepare("UPDATE published_artifacts SET mode = 'signin' WHERE share_token = ?")
      .bind(shareToken).run();

    const nonce = await mintAccessNonce(env, shareToken, u.id);
    const viewerCookie = await signViewerCookie(shareToken, env.VIEWER_COOKIE_SECRET);

    const res = await call(getReq(`/p/${shareToken}?key=${nonce}`, {
      cookie: `oyster_view_${shareToken}=${viewerCookie}`,
    }));
    expect(res.status).toBe(200);  // standard mode dispatch admits via cookie

    const row = await env.DB.prepare(
      "SELECT consumed_at FROM viewer_access_nonces WHERE nonce = ?",
    ).bind(nonce).first<{ consumed_at: number | null }>();
    expect(row?.consumed_at).toBeNull();
  });
});

describe("password gate — sign-in link", () => {
  it('shows "Have access? Sign in to view" link pointing at access-redirect', async () => {
    const u = await seedUser();
    const token = await seedActivePublication({
      ownerUserId: u.id, artifactId: "art_gate", mode: "password",
    });
    const res = await call(getReq(`/p/${token}`));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Have access?");
    expect(body).toContain(`https://oyster.to/api/publish/access-redirect/${token}`);
  });

  it("link is present on the wrong-password error state too", async () => {
    const u = await seedUser();
    // Use a stub PBKDF2 hash that verifyPbkdf2 will reject for any input
    // (well-formed but not derivable). Submitting "wrong" produces the error block.
    const token = await seedActivePublication({
      ownerUserId: u.id, artifactId: "art_gate2", mode: "password",
      passwordHash: "pbkdf2$100000$AAAA$BBBB",
    });
    const res = await call(postReq(`/p/${token}`, { password: "wrong" }));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Incorrect password.");
    expect(body).toContain("Have access?");
  });
});

describe("rendered viewer responses — Referrer-Policy", () => {
  it("open-mode markdown render carries referrer-policy: no-referrer", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art_rp_open", body: "# hi",
    });
    const res = await call(getReq(`/p/${shareToken}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("password-mode (post-unlock) render carries referrer-policy: no-referrer", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art_rp_pw", body: "# secret",
    });
    await env.DB.prepare(
      "UPDATE published_artifacts SET mode = 'password', password_hash = 'pbkdf2$100000$AAAA$BBBB' WHERE share_token = ?",
    ).bind(shareToken).run();

    // Hand-mint a valid viewer cookie so we exercise the rendered response path.
    const cookieValue = await signViewerCookie(shareToken, env.VIEWER_COOKIE_SECRET);
    const res = await call(getReq(`/p/${shareToken}`, {
      cookie: `oyster_view_${shareToken}=${cookieValue}`,
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
