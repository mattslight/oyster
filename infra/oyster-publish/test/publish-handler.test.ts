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

describe("POST /api/publish/upload — race recovery", () => {
  it("two concurrent first-publishes return the same share_token, one D1 row, one R2 object", async () => {
    const u = await seedUser();
    const body = "racing";

    function call6() {
      return call(uploadRequest({
        cookieHeader: authHeader(u.sessionToken),
        metadata: metadataHeader({ artifact_id: "art_race", artifact_kind: "notes", mode: "open" }),
        contentType: "text/plain",
        contentLength: String(body.length),
        body,
      }));
    }

    const [r1, r2] = await Promise.all([call6(), call6()]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const j1 = await r1.json() as any;
    const j2 = await r2.json() as any;

    // Both return the same share_token.
    expect(j1.share_token).toBe(j2.share_token);

    // Exactly one row.
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM published_artifacts WHERE owner_user_id = ? AND artifact_id = ? AND unpublished_at IS NULL"
    ).bind(u.id, "art_race").first<{ n: number }>();
    expect(rows?.n).toBe(1);

    // R2 object exists at the winning token (check existence only, don't consume stream).
    const obj = await env.ARTIFACTS.get(`published/${u.id}/${j1.share_token}`);
    if (obj) {
      // Consume any stream to ensure cleanup happens
      await obj.text().catch(() => {});
    }
    expect(obj).toBeTruthy();
  });
});

describe("POST /api/publish/upload — cross-owner non-conflict", () => {
  it("two users may publish artefacts that share an artifact_id without conflict", async () => {
    const a = await seedUser({ id: "user_a", email: "a@example.com" });
    const b = await seedUser({ id: "user_b", email: "b@example.com" });

    const body = "shared";
    const ra = await call(uploadRequest({
      cookieHeader: authHeader(a.sessionToken),
      metadata: metadataHeader({ artifact_id: "shared_id", artifact_kind: "notes", mode: "open" }),
      contentType: "text/plain",
      contentLength: String(body.length),
      body,
    }));
    const rb = await call(uploadRequest({
      cookieHeader: authHeader(b.sessionToken),
      metadata: metadataHeader({ artifact_id: "shared_id", artifact_kind: "notes", mode: "open" }),
      contentType: "text/plain",
      contentLength: String(body.length),
      body,
    }));
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    const ja = await ra.json() as any;
    const jb = await rb.json() as any;
    expect(ja.share_token).not.toBe(jb.share_token);

    const rows = await env.DB.prepare(
      "SELECT owner_user_id FROM published_artifacts WHERE artifact_id = ? AND unpublished_at IS NULL ORDER BY owner_user_id"
    ).bind("shared_id").all<{ owner_user_id: string }>();
    expect(rows.results.map(r => r.owner_user_id)).toEqual(["user_a", "user_b"]);
  });
});

describe("POST /api/publish/upload — D1 CHECK enforcement", () => {
  it("rejects an open-mode publish that smuggles a password_hash", async () => {
    const u = await seedUser();
    const body = "x";
    const res = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: metadataHeader({
        artifact_id: "art_check", artifact_kind: "notes", mode: "open",
        password_hash: "pbkdf2$100000$x$y",  // illegal for open mode
      }),
      contentType: "text/plain",
      contentLength: String(body.length),
      body,
    }));
    // Caught by the handler's defence-in-depth (Task 2.5) before reaching D1.
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_metadata" });
  });
});

describe("POST /api/publish/upload — streamed-size enforcement", () => {
  it("aborts mid-stream when streamed bytes exceed cap despite Content-Length under cap", async () => {
    const u = await seedUser();
    const liedLength = 10;  // claim 10 bytes
    const realBody = new Uint8Array(11 * 1024 * 1024);  // actually send 11 MB
    realBody.fill(0x41);
    const res = await call(uploadRequest({
      cookieHeader: authHeader(u.sessionToken),
      metadata: metadataHeader({ artifact_id: "art_stream", artifact_kind: "notes", mode: "open" }),
      contentType: "application/octet-stream",
      contentLength: String(liedLength),
      body: realBody,
    }));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "artifact_too_large" });
    // No D1 row left behind.
    const row = await env.DB.prepare(
      "SELECT * FROM published_artifacts WHERE owner_user_id = ? AND artifact_id = ?"
    ).bind(u.id, "art_stream").first();
    expect(row).toBeNull();
  });
});
