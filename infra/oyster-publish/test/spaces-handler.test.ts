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

// Suppress unused-import warning until tasks 3 + 4 land.
void readSyncedSpace;
