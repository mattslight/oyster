import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import {
  applySchema, seedUser, seedActivePublication, retirePublication,
  putR2Object, seedActiveOpenWithBody,
} from "./fixtures/seed";
import { signViewerCookie } from "../src/viewer-cookie";

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
  return new Request(`https://oyster.to${path}`, { method: "GET", headers });
}

function postReq(path: string, opts: { cookie?: string; password?: string } = {}): Request {
  const headers = new Headers();
  if (opts.cookie) headers.set("Cookie", opts.cookie);
  headers.set("Content-Type", "application/x-www-form-urlencoded");
  const body = new URLSearchParams();
  if (opts.password !== undefined) body.set("password", opts.password);
  return new Request(`https://oyster.to${path}`, { method: "POST", headers, body: body.toString() });
}

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

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
    expect(body).toContain("🦪 oyster"); // chrome present
    expect(body).toContain("Powered by Oyster");
  });

  it("sets open-mode cache headers + ETag", async () => {
    const u = await seedUser();
    const { shareToken } = await seedActiveOpenWithBody({
      ownerUserId: u.id, artifactId: "art1", body: "# x",
    });
    const res = await call(getReq(`/p/${shareToken}`));
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
    expect(res.headers.get("etag")).toMatch(/^W\/"[^"]+"$/);
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
    expect(body).toContain('sandbox="allow-scripts"');
    expect(body).not.toMatch(/sandbox="[^"]*allow-same-origin/);
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
    expect(res.headers.get("content-type")).toBe("text/html");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(await res.text()).toBe("<h1>raw app</h1>");
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

describe("GET /p/:token — signin mode", () => {
  it("unsigned visitor → 302 to /auth/sign-in?return=/p/<token>", async () => {
    const u = await seedUser();
    const token = await seedActivePublication({
      ownerUserId: u.id, artifactId: "art3", mode: "signin",
    });
    const res = await call(getReq(`/p/${token}`));
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toBe(`https://oyster.to/auth/sign-in?return=/p/${token}`);
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
});
