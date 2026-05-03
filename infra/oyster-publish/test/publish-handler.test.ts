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
