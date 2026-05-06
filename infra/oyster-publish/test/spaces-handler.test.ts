import { describe, it, expect, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import { applySchema, seedUser, authHeader, seedSyncedSpace, readSyncedSpace } from "./fixtures/seed";

beforeEach(async () => { await applySchema(); });

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function mineRequest(cookie?: string): Request {
  const headers = new Headers();
  if (cookie) headers.set("Cookie", cookie);
  return new Request("https://oyster.to/api/spaces/mine", { method: "GET", headers });
}

describe("GET /api/spaces/mine", () => {
  it("returns 401 sign_in_required when cookie missing", async () => {
    const res = await call(mineRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "sign_in_required" });
  });

  it("returns empty array when user has no spaces", async () => {
    const u = await seedUser();
    const res = await call(mineRequest(authHeader(u.sessionToken).Cookie));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ spaces: [] });
  });

  it("returns the user's spaces, including tombstones, ordered by updated_at desc", async () => {
    const u = await seedUser();
    await seedSyncedSpace({ ownerId: u.id, spaceId: "work", updatedAt: 1000 });
    await seedSyncedSpace({ ownerId: u.id, spaceId: "home", updatedAt: 3000 });
    await seedSyncedSpace({ ownerId: u.id, spaceId: "old",  updatedAt: 2000, deletedAt: 2500 });

    const res = await call(mineRequest(authHeader(u.sessionToken).Cookie));
    expect(res.status).toBe(200);
    const json = await res.json() as { spaces: Array<Record<string, unknown>> };
    expect(json.spaces).toHaveLength(3);
    expect(json.spaces[0]).toMatchObject({ space_id: "home", deleted_at: null });
    expect(json.spaces[1]).toMatchObject({ space_id: "old",  deleted_at: 2500 });
    expect(json.spaces[2]).toMatchObject({ space_id: "work", deleted_at: null });
  });

  it("scopes results to the calling user (no leak)", async () => {
    const u1 = await seedUser({ id: "u1", email: "u1@e.com" });
    const u2 = await seedUser({ id: "u2", email: "u2@e.com" });
    await seedSyncedSpace({ ownerId: u1.id, spaceId: "u1-space" });
    await seedSyncedSpace({ ownerId: u2.id, spaceId: "u2-space" });

    const res = await call(mineRequest(authHeader(u1.sessionToken).Cookie));
    const json = await res.json() as { spaces: Array<{ space_id: string }> };
    expect(json.spaces.map((s) => s.space_id)).toEqual(["u1-space"]);
  });

  it("sets cache-control: private, no-store", async () => {
    const u = await seedUser();
    const res = await call(mineRequest(authHeader(u.sessionToken).Cookie));
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

function putRequest(spaceId: string, body: object, cookie?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (cookie) headers.set("Cookie", cookie);
  return new Request(`https://oyster.to/api/spaces/${spaceId}`, {
    method: "PUT", headers, body: JSON.stringify(body),
  });
}

describe("PUT /api/spaces/:id", () => {
  it("returns 401 when cookie missing", async () => {
    const res = await call(putRequest("work", { display_name: "Work", updated_at: 1000 }));
    expect(res.status).toBe(401);
  });

  it("creates a new row when none exists, returns 200 with the row", async () => {
    const u = await seedUser();
    const res = await call(putRequest("work", {
      display_name: "Work", color: "#6057c4", parent_id: null,
      summary_title: null, summary_content: null, updated_at: 5000,
    }, authHeader(u.sessionToken).Cookie));

    expect(res.status).toBe(200);
    const json = await res.json() as { space: Record<string, unknown> };
    expect(json.space).toMatchObject({
      space_id: "work", display_name: "Work", color: "#6057c4",
      updated_at: 5000, deleted_at: null,
    });

    const row = await readSyncedSpace(u.id, "work");
    expect(row).toMatchObject({ display_name: "Work", updated_at: 5000 });
  });

  it("updates an existing row when incoming updated_at is greater", async () => {
    const u = await seedUser();
    await seedSyncedSpace({ ownerId: u.id, spaceId: "work", displayName: "Old", updatedAt: 1000 });

    const res = await call(putRequest("work", {
      display_name: "New", color: null, parent_id: null,
      summary_title: null, summary_content: null, updated_at: 2000,
    }, authHeader(u.sessionToken).Cookie));

    expect(res.status).toBe(200);
    const json = await res.json() as { space: Record<string, unknown> };
    expect(json.space).toMatchObject({ display_name: "New", updated_at: 2000 });
  });

  it("rejects stale writes (updated_at <= existing) with 200 returning the existing row (no-op)", async () => {
    const u = await seedUser();
    await seedSyncedSpace({ ownerId: u.id, spaceId: "work", displayName: "Current", updatedAt: 5000 });

    const res = await call(putRequest("work", {
      display_name: "Stale", color: null, parent_id: null,
      summary_title: null, summary_content: null, updated_at: 3000,
    }, authHeader(u.sessionToken).Cookie));

    expect(res.status).toBe(200);
    const json = await res.json() as { space: Record<string, unknown> };
    expect(json.space).toMatchObject({ display_name: "Current", updated_at: 5000 });
  });

  it("returns 410 gone when PUTting to a tombstoned row", async () => {
    const u = await seedUser();
    await seedSyncedSpace({ ownerId: u.id, spaceId: "work", updatedAt: 1000, deletedAt: 1500 });

    const res = await call(putRequest("work", {
      display_name: "Reborn", color: null, parent_id: null,
      summary_title: null, summary_content: null, updated_at: 2000,
    }, authHeader(u.sessionToken).Cookie));

    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: "space_tombstoned" });
  });

  it("returns 400 invalid_metadata when display_name missing", async () => {
    const u = await seedUser();
    const res = await call(putRequest("work", { updated_at: 1000 },
      authHeader(u.sessionToken).Cookie));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_metadata" });
  });

  it("returns 400 invalid_metadata when updated_at missing or non-numeric", async () => {
    const u = await seedUser();
    const res = await call(putRequest("work", { display_name: "Work" },
      authHeader(u.sessionToken).Cookie));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_metadata" });
  });
});

function deleteRequest(spaceId: string, cookie?: string): Request {
  const headers = new Headers();
  if (cookie) headers.set("Cookie", cookie);
  return new Request(`https://oyster.to/api/spaces/${spaceId}`, { method: "DELETE", headers });
}

describe("DELETE /api/spaces/:id", () => {
  it("returns 401 when cookie missing", async () => {
    const res = await call(deleteRequest("work"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when the row does not exist", async () => {
    const u = await seedUser();
    const res = await call(deleteRequest("ghost", authHeader(u.sessionToken).Cookie));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "space_not_found" });
  });

  it("sets deleted_at and bumps updated_at on a live row", async () => {
    const u = await seedUser();
    await seedSyncedSpace({ ownerId: u.id, spaceId: "work", updatedAt: 1000 });

    const res = await call(deleteRequest("work", authHeader(u.sessionToken).Cookie));
    expect(res.status).toBe(200);
    const json = await res.json() as { space_id: string; deleted_at: number; updated_at: number };
    expect(json.space_id).toBe("work");
    expect(json.deleted_at).toBeGreaterThan(0);
    expect(json.updated_at).toBeGreaterThan(1000);

    const row = await readSyncedSpace(u.id, "work");
    expect(row?.deleted_at).toBe(json.deleted_at);
    expect(row?.updated_at).toBe(json.updated_at);
  });

  it("is idempotent — re-DELETE returns the existing tombstone", async () => {
    const u = await seedUser();
    await seedSyncedSpace({
      ownerId: u.id, spaceId: "work", updatedAt: 1000, deletedAt: 1500,
    });

    const res = await call(deleteRequest("work", authHeader(u.sessionToken).Cookie));
    expect(res.status).toBe(200);
    const json = await res.json() as { space_id: string; deleted_at: number };
    expect(json.deleted_at).toBe(1500);
  });
});
