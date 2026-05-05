import { describe, it, expect, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import { applySchema, seedUser, authHeader } from "./fixtures/seed";

beforeEach(async () => {
  await applySchema();
});

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function mineRequest(cookie?: string): Request {
  const headers = new Headers();
  if (cookie) headers.set("Cookie", cookie);
  return new Request("https://oyster.to/api/publish/mine", { method: "GET", headers });
}

async function seedPublication(opts: {
  ownerId: string;
  shareToken: string;
  artifactId: string;
  mode?: string;
  publishedAt?: number;
  unpublishedAt?: number | null;
  label?: string | null;
  spaceId?: string | null;
}): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO published_artifacts
     (share_token, owner_user_id, artifact_id, artifact_kind, mode, password_hash,
      r2_key, content_type, size_bytes, published_at, updated_at, unpublished_at,
      label, space_id)
     VALUES (?, ?, ?, 'notes', ?, NULL, ?, 'text/plain', 5,
             ?, ?, ?, ?, ?)`
  ).bind(
    opts.shareToken, opts.ownerId, opts.artifactId, opts.mode ?? "open",
    `published/${opts.ownerId}/${opts.shareToken}`,
    opts.publishedAt ?? now, opts.publishedAt ?? now,
    opts.unpublishedAt ?? null,
    opts.label ?? null, opts.spaceId ?? null,
  ).run();
}

describe("GET /api/publish/mine", () => {
  it("returns 401 sign_in_required when cookie missing", async () => {
    const res = await call(mineRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "sign_in_required" });
  });

  it("returns the user's live publications, newest first", async () => {
    const u = await seedUser();
    await seedPublication({ ownerId: u.id, shareToken: "tok_a", artifactId: "art_a", publishedAt: 1000 });
    await seedPublication({ ownerId: u.id, shareToken: "tok_b", artifactId: "art_b", publishedAt: 2000 });

    const res = await call(mineRequest(authHeader(u.sessionToken).Cookie));
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.publications).toHaveLength(2);
    expect(json.publications[0].artifact_id).toBe("art_b");
    expect(json.publications[1].artifact_id).toBe("art_a");
    expect(json.publications[0]).toMatchObject({
      share_token: "tok_b",
      mode: "open",
      content_type: "text/plain",
    });
  });

  it("excludes unpublished (tombstone) rows", async () => {
    const u = await seedUser();
    const now = Date.now();
    await seedPublication({ ownerId: u.id, shareToken: "tok_live", artifactId: "art_live" });
    await seedPublication({
      ownerId: u.id, shareToken: "tok_dead", artifactId: "art_dead",
      unpublishedAt: now,
    });

    const res = await call(mineRequest(authHeader(u.sessionToken).Cookie));
    const json = await res.json() as any;
    expect(json.publications).toHaveLength(1);
    expect(json.publications[0].share_token).toBe("tok_live");
  });

  it("returns label + space_id when present", async () => {
    const u = await seedUser();
    await seedPublication({
      ownerId: u.id, shareToken: "tok_ctx", artifactId: "art_ctx",
      label: "Pricing v3", spaceId: "client-projects",
    });
    const res = await call(mineRequest(authHeader(u.sessionToken).Cookie));
    const json = await res.json() as any;
    expect(json.publications[0]).toMatchObject({
      label: "Pricing v3",
      space_id: "client-projects",
    });
  });

  it("returns NULL label/space_id for older rows without context", async () => {
    const u = await seedUser();
    await seedPublication({
      ownerId: u.id, shareToken: "tok_old", artifactId: "art_old",
      label: null, spaceId: null,
    });
    const res = await call(mineRequest(authHeader(u.sessionToken).Cookie));
    const json = await res.json() as any;
    expect(json.publications[0].label).toBeNull();
    expect(json.publications[0].space_id).toBeNull();
  });

  it("never returns rows owned by another user", async () => {
    const a = await seedUser({ id: "uA", email: "a@a" });
    const b = await seedUser({ id: "uB", email: "b@b" });
    await seedPublication({ ownerId: b.id, shareToken: "tok_b_only", artifactId: "art_b_only" });
    const res = await call(mineRequest(authHeader(a.sessionToken).Cookie));
    const json = await res.json() as any;
    expect(json.publications).toHaveLength(0);
  });
});

describe("PATCH /api/publish/:share_token", () => {
  async function patchRequest(opts: { cookie?: string; token: string; body: unknown }): Promise<Response> {
    const headers = new Headers();
    if (opts.cookie) headers.set("Cookie", opts.cookie);
    headers.set("Content-Type", "application/json");
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`https://oyster.to/api/publish/${opts.token}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(opts.body),
      }),
      env, ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("returns 401 when cookie missing", async () => {
    const res = await patchRequest({ token: "tok", body: { mode: "open" } });
    expect(res.status).toBe(401);
  });

  it("returns 404 publication_not_found for unknown share_token", async () => {
    const u = await seedUser();
    const res = await patchRequest({ cookie: authHeader(u.sessionToken).Cookie, token: "missing", body: { mode: "open" } });
    expect(res.status).toBe(404);
  });

  it("returns 403 not_publication_owner when caller is not the owner", async () => {
    const a = await seedUser({ id: "a", email: "a@a" });
    const b = await seedUser({ id: "b", email: "b@b" });
    await seedPublication({ ownerId: a.id, shareToken: "tok_a", artifactId: "art_a" });
    const res = await patchRequest({ cookie: authHeader(b.sessionToken).Cookie, token: "tok_a", body: { mode: "signin" } });
    expect(res.status).toBe(403);
  });

  it("free user cannot switch a publication TO password mode (402 pro_required)", async () => {
    const u = await seedUser({ tier: "free" });
    await seedPublication({ ownerId: u.id, shareToken: "tok_p", artifactId: "art_p" });
    const res = await patchRequest({
      cookie: authHeader(u.sessionToken).Cookie,
      token: "tok_p",
      body: { mode: "password", password_hash: "pbkdf2$x" },
    });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "pro_required" });
  });

  it("pro user can flip an existing open publication to password and back", async () => {
    const u = await seedUser({ tier: "pro" });
    await seedPublication({ ownerId: u.id, shareToken: "tok_q", artifactId: "art_q" });

    const r1 = await patchRequest({
      cookie: authHeader(u.sessionToken).Cookie,
      token: "tok_q",
      body: { mode: "password", password_hash: "pbkdf2$secret" },
    });
    expect(r1.status).toBe(200);
    const row1 = await env.DB.prepare("SELECT mode, password_hash FROM published_artifacts WHERE share_token = 'tok_q'").first<{ mode: string; password_hash: string | null }>();
    expect(row1?.mode).toBe("password");
    expect(row1?.password_hash).toBe("pbkdf2$secret");

    const r2 = await patchRequest({
      cookie: authHeader(u.sessionToken).Cookie,
      token: "tok_q",
      body: { mode: "open" },
    });
    expect(r2.status).toBe(200);
    const row2 = await env.DB.prepare("SELECT mode, password_hash FROM published_artifacts WHERE share_token = 'tok_q'").first<{ mode: string; password_hash: string | null }>();
    expect(row2?.mode).toBe("open");
    expect(row2?.password_hash).toBeNull();
  });

  it("rejects open mode that smuggles a password_hash", async () => {
    const u = await seedUser();
    await seedPublication({ ownerId: u.id, shareToken: "tok_x", artifactId: "art_x" });
    const res = await patchRequest({
      cookie: authHeader(u.sessionToken).Cookie,
      token: "tok_x",
      body: { mode: "open", password_hash: "pbkdf2$x" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 410 publication_retired for an already-unpublished row", async () => {
    const u = await seedUser({ tier: "pro" });
    await seedPublication({ ownerId: u.id, shareToken: "tok_dead", artifactId: "art_dead", unpublishedAt: Date.now() });
    const res = await patchRequest({
      cookie: authHeader(u.sessionToken).Cookie,
      token: "tok_dead",
      body: { mode: "open" },
    });
    expect(res.status).toBe(410);
  });

});
