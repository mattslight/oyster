import { describe, it, expect, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import { applySchema, seedUser, authHeader, metadataHeader } from "./fixtures/seed";

beforeEach(async () => {
  await applySchema();
});

function uploadRequest(opts: {
  cookieHeader?: Record<string, string>;
  metadata?: string;
  contentType?: string;
  contentLength?: string | null;
  body?: BodyInit | null;
} = {}): Request {
  const headers = new Headers();
  if (opts.cookieHeader?.Cookie) headers.set("Cookie", opts.cookieHeader.Cookie);
  if (opts.metadata !== undefined) headers.set("X-Publish-Metadata", opts.metadata);
  if (opts.contentType) headers.set("Content-Type", opts.contentType);
  if (opts.contentLength !== null) {
    const len = opts.contentLength ?? (opts.body ? String((opts.body as string).length) : "0");
    headers.set("Content-Length", len);
  }
  return new Request("https://oyster.to/api/publish/upload", {
    method: "POST",
    headers,
    body: opts.body ?? null,
  });
}

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("POST /api/publish/upload — auth", () => {
  it("returns 401 sign_in_required when cookie is missing", async () => {
    const res = await call(uploadRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "sign_in_required" });
  });

  it("returns 401 sign_in_required when cookie has unknown token", async () => {
    const res = await call(uploadRequest({ cookieHeader: { Cookie: "oyster_session=fake" } }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/publish/upload — metadata + size validation", () => {
  it("returns 400 invalid_metadata when X-Publish-Metadata is missing", async () => {
    const u = await seedUser();
    const res = await call(uploadRequest({ cookieHeader: authHeader(u.sessionToken) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_metadata" });
  });

  it("returns 400 invalid_metadata when payload is malformed", async () => {
    const u = await seedUser();
    const res = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: "!!!not-base64!!!",
    }));
    expect(res.status).toBe(400);
  });

  it("returns 400 password_required when mode=password and hash absent", async () => {
    const u = await seedUser();
    const res = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: metadataHeader({ artifact_id: "a", artifact_kind: "notes", mode: "password" }),
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "password_required" });
  });

  it("returns 411 content_length_required when Content-Length missing", async () => {
    const u = await seedUser();
    const res = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: metadataHeader({ artifact_id: "a", artifact_kind: "notes", mode: "open" }),
      contentLength: null,
      contentType: "text/plain",
    }));
    expect(res.status).toBe(411);
    expect(await res.json()).toMatchObject({ error: "content_length_required" });
  });

  it("returns 413 artifact_too_large when Content-Length > cap", async () => {
    const u = await seedUser();
    const res = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: metadataHeader({ artifact_id: "a", artifact_kind: "notes", mode: "open" }),
      contentType: "text/plain",
      contentLength: String(11 * 1024 * 1024),
      body: "x",
    }));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "artifact_too_large", limit_bytes: 10 * 1024 * 1024 });
  });
});

describe("POST /api/publish/upload — first publish (open mode)", () => {
  it("creates a row, writes R2, returns 200 with token + URL", async () => {
    const u = await seedUser();
    const body = "# Hello world";
    const res = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: metadataHeader({ artifact_id: "art_1", artifact_kind: "notes", mode: "open" }),
      contentType: "text/markdown",
      contentLength: String(new TextEncoder().encode(body).byteLength),
      body,
    }));
    expect(res.status).toBe(200);
    const json = await res.json() as { share_token: string; share_url: string; mode: string; published_at: number; updated_at: number };
    expect(json.share_token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(json.share_url).toBe(`https://oyster.to/p/${json.share_token}`);
    expect(json.mode).toBe("open");
    expect(json.published_at).toBeTypeOf("number");
    expect(json.updated_at).toBe(json.published_at);

    // D1 row exists.
    const row = await env.DB.prepare("SELECT * FROM published_artifacts WHERE share_token = ?")
      .bind(json.share_token).first();
    expect(row).toBeTruthy();
    expect((row as any).owner_user_id).toBe(u.id);
    expect((row as any).artifact_id).toBe("art_1");
    expect((row as any).unpublished_at).toBeNull();

    // R2 object exists with the right bytes.
    const obj = await env.ARTIFACTS.get(`published/${u.id}/${json.share_token}`);
    expect(obj).toBeTruthy();
    expect(await obj!.text()).toBe(body);
  });
});

describe("POST /api/publish/upload — re-publish (upsert)", () => {
  it("keeps share_token, refreshes bytes + mode, preserves published_at", async () => {
    const u = await seedUser();
    const firstBody = "v1";
    const first = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: metadataHeader({ artifact_id: "art_1", artifact_kind: "notes", mode: "open" }),
      contentType: "text/plain",
      contentLength: String(firstBody.length),
      body: firstBody,
    }));
    const firstJson = await first.json() as any;
    expect(first.status).toBe(200);

    // Wait a beat so updated_at can plausibly differ from published_at.
    await new Promise(r => setTimeout(r, 5));

    const secondBody = "v2 with hash";
    const second = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: metadataHeader({
        artifact_id: "art_1", artifact_kind: "notes",
        mode: "password", password_hash: "pbkdf2$100000$x$y",
      }),
      contentType: "text/plain",
      contentLength: String(secondBody.length),
      body: secondBody,
    }));
    expect(second.status).toBe(200);
    const secondJson = await second.json() as any;
    expect(secondJson.share_token).toBe(firstJson.share_token);  // stable
    expect(secondJson.mode).toBe("password");
    expect(secondJson.published_at).toBe(firstJson.published_at);  // preserved
    expect(secondJson.updated_at).toBeGreaterThanOrEqual(firstJson.updated_at);

    const obj = await env.ARTIFACTS.get(`published/${u.id}/${firstJson.share_token}`);
    expect(await obj!.text()).toBe(secondBody);

    const row = await env.DB.prepare("SELECT mode, password_hash FROM published_artifacts WHERE share_token = ?")
      .bind(firstJson.share_token).first<any>();
    expect(row.mode).toBe("password");
    expect(row.password_hash).toBe("pbkdf2$100000$x$y");
  });
});

describe("POST /api/publish/upload — cap enforcement", () => {
  it("returns 402 publish_cap_exceeded on 6th distinct artefact", async () => {
    const u = await seedUser();
    for (let i = 0; i < 5; i++) {
      const body = `body ${i}`;
      const res = await call(uploadRequest({
        cookieHeader: authHeader(u.sessionToken),
        metadata: metadataHeader({ artifact_id: `art_${i}`, artifact_kind: "notes", mode: "open" }),
        contentType: "text/plain",
        contentLength: String(body.length),
        body,
      }));
      expect(res.status).toBe(200);
    }
    const body = "boom";
    const res = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: metadataHeader({ artifact_id: "art_6", artifact_kind: "notes", mode: "open" }),
      contentType: "text/plain",
      contentLength: String(body.length),
      body,
    }));
    expect(res.status).toBe(402);
    const json = await res.json() as any;
    expect(json.error).toBe("publish_cap_exceeded");
    expect(json.current).toBe(5);
    expect(json.limit).toBe(5);
  });

  it("does not count unpublished rows toward the cap", async () => {
    const u = await seedUser();
    // Seed 5 unpublished rows directly.
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const tok = `seeded_${i}`;
      await env.DB.prepare(
        `INSERT INTO published_artifacts
         (share_token, owner_user_id, artifact_id, artifact_kind, mode, password_hash,
          r2_key, content_type, size_bytes, published_at, updated_at, unpublished_at)
         VALUES (?, ?, ?, 'notes', 'open', NULL, ?, 'text/plain', 5, ?, ?, ?)`
      ).bind(tok, u.id, `seeded_art_${i}`, `published/${u.id}/${tok}`, now, now, now).run();
    }
    const body = "fresh";
    const res = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: metadataHeader({ artifact_id: "fresh_art", artifact_kind: "notes", mode: "open" }),
      contentType: "text/plain",
      contentLength: String(body.length),
      body,
    }));
    expect(res.status).toBe(200);
  });
});
