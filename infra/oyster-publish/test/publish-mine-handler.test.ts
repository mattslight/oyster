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
}): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO published_artifacts
     (share_token, owner_user_id, artifact_id, artifact_kind, mode, password_hash,
      r2_key, content_type, size_bytes, published_at, updated_at, unpublished_at)
     VALUES (?, ?, ?, 'notes', ?, NULL, ?, 'text/plain', 5,
             ?, ?, ?)`
  ).bind(
    opts.shareToken, opts.ownerId, opts.artifactId, opts.mode ?? "open",
    `published/${opts.ownerId}/${opts.shareToken}`,
    opts.publishedAt ?? now, opts.publishedAt ?? now,
    opts.unpublishedAt ?? null,
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

  it("never returns rows owned by another user", async () => {
    const a = await seedUser({ id: "user_a", email: "a@example.com" });
    const b = await seedUser({ id: "user_b", email: "b@example.com" });
    await seedPublication({ ownerId: b.id, shareToken: "tok_b", artifactId: "art_b" });

    const res = await call(mineRequest(authHeader(a.sessionToken).Cookie));
    const json = await res.json() as any;
    expect(json.publications).toHaveLength(0);
  });
});
