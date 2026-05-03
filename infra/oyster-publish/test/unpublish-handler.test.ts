import { describe, it, expect, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import { applySchema, seedUser, seedActivePublication, authHeader, metadataHeader } from "./fixtures/seed";

beforeEach(async () => {
  await applySchema();
});

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function deleteRequest(token: string, sessionToken?: string): Request {
  const headers = new Headers();
  if (sessionToken) headers.set("Cookie", `oyster_session=${sessionToken}`);
  return new Request(`https://oyster.to/api/publish/${token}`, { method: "DELETE", headers });
}

describe("DELETE /api/publish/:share_token", () => {
  it("returns 401 sign_in_required without a session cookie", async () => {
    const res = await call(deleteRequest("anytoken"));
    expect(res.status).toBe(401);
  });

  it("returns 404 publication_not_found for an unknown token", async () => {
    const u = await seedUser();
    const res = await call(deleteRequest("ghost", u.sessionToken));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "publication_not_found" });
  });

  it("returns 403 not_publication_owner when caller is not the owner", async () => {
    const owner = await seedUser({ id: "owner", email: "owner@example.com" });
    const stranger = await seedUser({ id: "stranger", email: "stranger@example.com" });
    const tok = await seedActivePublication({ ownerUserId: owner.id, artifactId: "art_x" });
    const res = await call(deleteRequest(tok, stranger.sessionToken));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_publication_owner" });
  });

  it("returns 200 and marks unpublished_at on first call", async () => {
    const u = await seedUser();
    const tok = await seedActivePublication({ ownerUserId: u.id, artifactId: "art_x" });
    // Seed an R2 object so we can verify the delete.
    await env.ARTIFACTS.put(`published/${u.id}/${tok}`, "bytes");

    const res = await call(deleteRequest(tok, u.sessionToken));
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.share_token).toBe(tok);
    expect(json.unpublished_at).toBeTypeOf("number");

    const row = await env.DB.prepare("SELECT unpublished_at FROM published_artifacts WHERE share_token = ?")
      .bind(tok).first<{ unpublished_at: number | null }>();
    expect(row?.unpublished_at).toBeTypeOf("number");

    const obj = await env.ARTIFACTS.get(`published/${u.id}/${tok}`);
    expect(obj).toBeNull();
  });

  it("is idempotent on a second call (already unpublished)", async () => {
    const u = await seedUser();
    const tok = await seedActivePublication({ ownerUserId: u.id, artifactId: "art_x" });
    await call(deleteRequest(tok, u.sessionToken));
    const second = await call(deleteRequest(tok, u.sessionToken));
    expect(second.status).toBe(200);
    const json = await second.json() as any;
    expect(json.ok).toBe(true);
  });
});

describe("publish → unpublish → publish round-trip", () => {
  // This test crosses both handlers; it lives here because the lifecycle is
  // anchored by unpublish (without it, the second publish would be an upsert).
  it("issues a new share_token after unpublish; old R2 object gone, new R2 object present", async () => {
    const u = await seedUser();
    const body = "first-bytes";

    // 1. First publish via the handler so we get a real generated token.
    const headers = new Headers();
    headers.set("Cookie", `oyster_session=${u.sessionToken}`);
    headers.set("X-Publish-Metadata", Buffer.from(JSON.stringify({
      artifact_id: "art_cycle", artifact_kind: "notes", mode: "open",
    })).toString("base64url"));
    headers.set("Content-Type", "text/plain");
    headers.set("Content-Length", String(body.length));
    const first = await call(new Request("https://oyster.to/api/publish/upload", {
      method: "POST", headers, body,
    }));
    expect(first.status).toBe(200);
    const firstJson = await first.json() as { share_token: string };

    // 2. Unpublish.
    const del = await call(deleteRequest(firstJson.share_token, u.sessionToken));
    expect(del.status).toBe(200);

    // 3. Republish.
    const second = await call(new Request("https://oyster.to/api/publish/upload", {
      method: "POST", headers, body: "second-bytes",
    }));
    expect(second.status).toBe(200);
    const secondJson = await second.json() as { share_token: string; share_url: string };

    // New token (not the same as first).
    expect(secondJson.share_token).not.toBe(firstJson.share_token);

    // Old R2 object gone (deleted by unpublish).
    const oldObj = await env.ARTIFACTS.get(`published/${u.id}/${firstJson.share_token}`);
    expect(oldObj).toBeNull();

    // New R2 object present with new bytes.
    const newObj = await env.ARTIFACTS.get(`published/${u.id}/${secondJson.share_token}`);
    expect(newObj).toBeTruthy();
    expect(await newObj!.text()).toBe("second-bytes");

    // Old D1 row marked unpublished; new row live.
    const oldRow = await env.DB.prepare("SELECT unpublished_at FROM published_artifacts WHERE share_token = ?")
      .bind(firstJson.share_token).first<{ unpublished_at: number | null }>();
    expect(oldRow?.unpublished_at).toBeTypeOf("number");
    const newRow = await env.DB.prepare("SELECT unpublished_at FROM published_artifacts WHERE share_token = ?")
      .bind(secondJson.share_token).first<{ unpublished_at: number | null }>();
    expect(newRow?.unpublished_at).toBeNull();
  });
});
