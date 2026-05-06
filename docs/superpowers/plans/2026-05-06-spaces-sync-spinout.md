# Spaces Sync Spin-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cloud-mirror the `spaces` table to D1 so a fresh signed-in device sees the user's spaces — and so published-artefact ghosts resolve to real spaces instead of `_cloud`.

**Architecture:** Local SQLite remains the immediate write target. Cloud (D1) is the cross-device source of truth. Dirty-row reconciliation, last-write-wins by `updated_at`. Mutations push fire-and-forget; sign-in does a full pull+push reconcile. Tombstones propagate deletes.

**Tech Stack:** Cloudflare D1 + Workers (`oyster-publish`), better-sqlite3, TypeScript, vitest, `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-05-06-spaces-sync-spinout-design.md`

---

## File structure

**New files:**
- `infra/auth-worker/migrations/0006_synced_spaces.sql` — D1 table + index
- `infra/oyster-publish/test/spaces-handler.test.ts` — worker endpoint tests
- `server/src/space-sync-service.ts` — local sync service (`reconcile()`, `pushOne()`)
- `server/test/space-sync-service.test.ts` — sync service unit tests

**Modified files:**
- `infra/oyster-publish/src/worker.ts` — three new endpoints (GET/PUT/DELETE `/api/spaces/...`)
- `infra/oyster-publish/test/fixtures/seed.ts` — extend test schema + helpers
- `server/src/db.ts` — additive ALTER TABLE for `cloud_synced_at`, `deleted_at`
- `server/src/space-store.ts` — soft-delete in `delete()`; new methods: `softDelete`, `getDirtyRows`, `markSynced`, `getAllIncludingDeleted`; filter `getAll`/`getById` on `deleted_at IS NULL`
- `server/src/space-service.ts` — accept `SpaceSyncService` dep; call `pushOne()` after every mutation
- `server/src/index.ts` — wire `spaceSync`; reconcile on sign-in BEFORE `backfillPublications`; reconcile on boot when signed in
- `CHANGELOG.md` — Changed entry

---

## Task 1: D1 migration for synced_spaces

**Files:**
- Create: `infra/auth-worker/migrations/0006_synced_spaces.sql`
- Modify: `infra/oyster-publish/test/fixtures/seed.ts` (add schema + seed helpers)

> **Migration ownership note:** the `oyster-publish` Worker reads/writes the *same* D1 database as `oyster-auth` (binding `DB`, db name `oyster-auth`, ID `44086805-...` per `infra/oyster-publish/wrangler.toml`). All D1 migrations for that shared DB live under `infra/auth-worker/migrations/` — adding spaces there matches the precedent set by `0003_publish.sql` (which created `published_artifacts`) and `0005_publish_context.sql`. Endpoints stay in `oyster-publish`.

- [ ] **Step 1: Write the migration file**

Create `infra/auth-worker/migrations/0006_synced_spaces.sql`:

```sql
-- 0006_synced_spaces.sql — cross-device mirror of the local spaces table.
-- Spec: docs/superpowers/specs/2026-05-06-spaces-sync-spinout-design.md
-- Wedge of #319 (R1). Used by the local server's space-sync-service to
-- reconcile per-user spaces across devices. Tombstones propagate deletes.
-- Lives in the shared oyster-auth D1 (oyster-publish Worker reads/writes it).

CREATE TABLE IF NOT EXISTS synced_spaces (
  owner_id        TEXT    NOT NULL,
  space_id        TEXT    NOT NULL,
  display_name    TEXT    NOT NULL,
  color           TEXT,
  parent_id       TEXT,
  summary_title   TEXT,
  summary_content TEXT,
  updated_at      INTEGER NOT NULL,    -- unix ms; LWW comparison key
  deleted_at      INTEGER,             -- tombstone; non-NULL means deleted
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (owner_id, space_id)
);

CREATE INDEX IF NOT EXISTS idx_synced_spaces_owner_updated
  ON synced_spaces (owner_id, updated_at DESC);
```

- [ ] **Step 2: Extend test fixture seed.ts with the new schema + helpers**

Open `infra/oyster-publish/test/fixtures/seed.ts`. Find the `SCHEMA_SQL` constant and append the synced_spaces table at the end of its multi-line string (before the closing backtick):

```sql
CREATE TABLE synced_spaces (
  owner_id        TEXT    NOT NULL,
  space_id        TEXT    NOT NULL,
  display_name    TEXT    NOT NULL,
  color           TEXT,
  parent_id       TEXT,
  summary_title   TEXT,
  summary_content TEXT,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (owner_id, space_id)
);
CREATE INDEX idx_synced_spaces_owner_updated
  ON synced_spaces (owner_id, updated_at DESC);
```

Then append two helper functions to the bottom of the file:

```ts
export async function seedSyncedSpace(opts: {
  ownerId: string;
  spaceId: string;
  displayName?: string;
  color?: string | null;
  parentId?: string | null;
  summaryTitle?: string | null;
  summaryContent?: string | null;
  updatedAt?: number;
  deletedAt?: number | null;
}): Promise<void> {
  const now = opts.updatedAt ?? Date.now();
  await env.DB.prepare(
    `INSERT INTO synced_spaces
     (owner_id, space_id, display_name, color, parent_id,
      summary_title, summary_content, updated_at, deleted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    opts.ownerId, opts.spaceId,
    opts.displayName ?? opts.spaceId,
    opts.color ?? null,
    opts.parentId ?? null,
    opts.summaryTitle ?? null,
    opts.summaryContent ?? null,
    now,
    opts.deletedAt ?? null,
    now,
  ).run();
}

export async function readSyncedSpace(
  ownerId: string, spaceId: string,
): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare(
    `SELECT owner_id, space_id, display_name, color, parent_id,
            summary_title, summary_content, updated_at, deleted_at, created_at
       FROM synced_spaces
      WHERE owner_id = ? AND space_id = ?`,
  ).bind(ownerId, spaceId).first<Record<string, unknown>>();
  return row ?? null;
}
```

- [ ] **Step 3: Apply migration to dev D1 (manual)**

Run from repo root:

```bash
cd infra/auth-worker && npx wrangler d1 migrations apply oyster-auth --local
```

Expected: `Migrations executed: 0006_synced_spaces.sql`. (For production, run `--remote` after merge.)

- [ ] **Step 4: Commit**

```bash
git add infra/auth-worker/migrations/0006_synced_spaces.sql \
        infra/oyster-publish/test/fixtures/seed.ts
git commit -m "feat(spaces-sync): D1 migration + test fixtures for synced_spaces"
```

---

## Task 2: Worker — GET /api/spaces/mine handler

**Files:**
- Modify: `infra/oyster-publish/src/worker.ts` (add route + handler)
- Create: `infra/oyster-publish/test/spaces-handler.test.ts`

- [ ] **Step 1: Write failing tests**

Create `infra/oyster-publish/test/spaces-handler.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd infra/oyster-publish && npm test -- spaces-handler.test.ts
```

Expected: FAIL — endpoint returns 404 (route not registered) for the "returns empty array" / "returns the user's spaces" tests.

- [ ] **Step 3: Add route + handler in worker.ts**

In `infra/oyster-publish/src/worker.ts`, inside the `fetch` handler's route table, add the GET route after the existing publish routes (after line 35, before the `/p/` block):

```ts
    if (url.pathname === "/api/spaces/mine" && req.method === "GET") {
      return handleSpacesMine(req, env);
    }
```

Then add the handler near the other `handlePublish*` handlers (after `handlePublishMine`):

```ts
async function handleSpacesMine(req: Request, env: Env): Promise<Response> {
  // Returns this signed-in user's synced spaces — both live rows AND tombstones,
  // so a peer device that's been offline can apply deletions on next reconcile.
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");

  type Row = {
    owner_id: string;
    space_id: string;
    display_name: string;
    color: string | null;
    parent_id: string | null;
    summary_title: string | null;
    summary_content: string | null;
    updated_at: number;
    deleted_at: number | null;
    created_at: number;
  };
  const rows = await env.DB.prepare(
    `SELECT owner_id, space_id, display_name, color, parent_id,
            summary_title, summary_content, updated_at, deleted_at, created_at
       FROM synced_spaces
      WHERE owner_id = ?
      ORDER BY updated_at DESC`,
  ).bind(user.id).all<Row>();

  // Per-user data — never cache at the browser, proxy, or edge layer.
  return jsonOk({ spaces: rows.results ?? [] }, 200, { "cache-control": "private, no-store" });
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd infra/oyster-publish && npm test -- spaces-handler.test.ts
```

Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add infra/oyster-publish/src/worker.ts infra/oyster-publish/test/spaces-handler.test.ts
git commit -m "feat(spaces-sync): GET /api/spaces/mine returns user spaces incl. tombstones"
```

---

## Task 3: Worker — PUT /api/spaces/:id handler

**Files:**
- Modify: `infra/oyster-publish/src/worker.ts`
- Modify: `infra/oyster-publish/test/spaces-handler.test.ts`

- [ ] **Step 1: Append failing PUT tests**

Append to the same `spaces-handler.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd infra/oyster-publish && npm test -- spaces-handler.test.ts
```

Expected: FAIL on the new PUT block — route returns 404.

- [ ] **Step 3: Add PUT route + handler**

In `worker.ts`, add this route after the GET route from Task 2:

```ts
    if (url.pathname.startsWith("/api/spaces/") && req.method === "PUT") {
      const raw = url.pathname.slice("/api/spaces/".length);
      // Reject any path with extra segments before decoding (defence in depth).
      if (raw.includes("/")) return new Response("Not Found", { status: 404 });
      let spaceId: string;
      try { spaceId = decodeURIComponent(raw); }
      catch { return jsonError(400, "invalid_space_id"); }
      return handleSpacesPut(req, env, spaceId);
    }
```

Add the handler near `handleSpacesMine`:

```ts
async function handleSpacesPut(req: Request, env: Env, spaceId: string): Promise<Response> {
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");
  if (!spaceId || spaceId.includes("/")) return jsonError(400, "invalid_space_id");

  let body: {
    display_name?: unknown;
    color?: unknown;
    parent_id?: unknown;
    summary_title?: unknown;
    summary_content?: unknown;
    updated_at?: unknown;
  };
  try { body = await req.json() as typeof body; }
  catch { return jsonError(400, "invalid_metadata"); }

  if (typeof body.display_name !== "string" || body.display_name.trim().length === 0) {
    return jsonError(400, "invalid_metadata");
  }
  if (body.display_name.length > 200) {
    // Cheap upper bound; protects D1 from pathological inputs.
    return jsonError(400, "invalid_metadata");
  }
  if (typeof body.updated_at !== "number" || !Number.isFinite(body.updated_at) || body.updated_at < 0) {
    return jsonError(400, "invalid_metadata");
  }

  // Strict optional-field validation — accept undefined (preserve), null (clear),
  // or string (set). Anything else is a 400.
  function validateOptional(name: string, v: unknown): { ok: true; value: string | null } | { ok: false } {
    if (v === undefined || v === null) return { ok: true, value: null };
    if (typeof v === "string") return { ok: true, value: v };
    return { ok: false };
  }
  const color          = validateOptional("color",          body.color);
  const parentId       = validateOptional("parent_id",      body.parent_id);
  const summaryTitle   = validateOptional("summary_title",  body.summary_title);
  const summaryContent = validateOptional("summary_content", body.summary_content);
  if (!color.ok || !parentId.ok || !summaryTitle.ok || !summaryContent.ok) {
    return jsonError(400, "invalid_metadata");
  }
  const incomingUpdated = body.updated_at;

  type Row = {
    owner_id: string; space_id: string; display_name: string;
    color: string | null; parent_id: string | null;
    summary_title: string | null; summary_content: string | null;
    updated_at: number; deleted_at: number | null; created_at: number;
  };
  const existing = await env.DB.prepare(
    `SELECT owner_id, space_id, display_name, color, parent_id,
            summary_title, summary_content, updated_at, deleted_at, created_at
       FROM synced_spaces WHERE owner_id = ? AND space_id = ?`,
  ).bind(user.id, spaceId).first<Row>();

  // Resurrection rule — peer pushed an update after this device tombstoned.
  // 410 tells the peer to apply the tombstone locally and stop dirty-retrying.
  if (existing && existing.deleted_at !== null) {
    return jsonError(410, "space_tombstoned");
  }

  // Last-write-wins: stale writes become no-ops returning the existing row.
  if (existing && incomingUpdated <= existing.updated_at) {
    return jsonOk({ space: existing });
  }

  const now = Date.now();
  if (existing) {
    await env.DB.prepare(
      `UPDATE synced_spaces
          SET display_name = ?, color = ?, parent_id = ?,
              summary_title = ?, summary_content = ?, updated_at = ?
        WHERE owner_id = ? AND space_id = ?`,
    ).bind(
      body.display_name.trim(), color.value, parentId.value,
      summaryTitle.value, summaryContent.value, incomingUpdated,
      user.id, spaceId,
    ).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO synced_spaces
       (owner_id, space_id, display_name, color, parent_id,
        summary_title, summary_content, updated_at, deleted_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).bind(
      user.id, spaceId, body.display_name.trim(), color.value, parentId.value,
      summaryTitle.value, summaryContent.value, incomingUpdated, now,
    ).run();
  }

  const row = await env.DB.prepare(
    `SELECT owner_id, space_id, display_name, color, parent_id,
            summary_title, summary_content, updated_at, deleted_at, created_at
       FROM synced_spaces WHERE owner_id = ? AND space_id = ?`,
  ).bind(user.id, spaceId).first<Row>();

  return jsonOk({ space: row });
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd infra/oyster-publish && npm test -- spaces-handler.test.ts
```

Expected: PASS, all 12 tests (5 GET + 7 PUT).

- [ ] **Step 5: Commit**

```bash
git add infra/oyster-publish/src/worker.ts infra/oyster-publish/test/spaces-handler.test.ts
git commit -m "feat(spaces-sync): PUT /api/spaces/:id with LWW + tombstone resurrection rule"
```

---

## Task 4: Worker — DELETE /api/spaces/:id handler

**Files:**
- Modify: `infra/oyster-publish/src/worker.ts`
- Modify: `infra/oyster-publish/test/spaces-handler.test.ts`

- [ ] **Step 1: Append failing DELETE tests**

Append to `spaces-handler.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd infra/oyster-publish && npm test -- spaces-handler.test.ts
```

Expected: FAIL on new DELETE block.

- [ ] **Step 3: Add DELETE route + handler**

In `worker.ts`, add this route after the PUT route from Task 3:

```ts
    if (url.pathname.startsWith("/api/spaces/") && req.method === "DELETE") {
      const raw = url.pathname.slice("/api/spaces/".length);
      if (raw.includes("/")) return new Response("Not Found", { status: 404 });
      let spaceId: string;
      try { spaceId = decodeURIComponent(raw); }
      catch { return jsonError(400, "invalid_space_id"); }
      return handleSpacesDelete(req, env, spaceId);
    }
```

Add the handler:

```ts
async function handleSpacesDelete(req: Request, env: Env, spaceId: string): Promise<Response> {
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");
  if (!spaceId || spaceId.includes("/")) return jsonError(400, "invalid_space_id");

  type Row = { deleted_at: number | null; updated_at: number };
  const existing = await env.DB.prepare(
    "SELECT deleted_at, updated_at FROM synced_spaces WHERE owner_id = ? AND space_id = ?",
  ).bind(user.id, spaceId).first<Row>();

  // 404 means: there's no cloud row to tombstone — the local delete is the
  // only state that ever existed for this id. Caller treats 404 as "already
  // gone elsewhere; mark the local tombstone synced and stop retrying."
  if (!existing) return jsonError(404, "space_not_found");

  // Idempotent: existing tombstone returns as-is.
  if (existing.deleted_at !== null) {
    return jsonOk({
      space_id: spaceId,
      deleted_at: existing.deleted_at,
      updated_at: existing.updated_at,
    });
  }

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE synced_spaces
        SET deleted_at = ?, updated_at = ?
      WHERE owner_id = ? AND space_id = ?`,
  ).bind(now, now, user.id, spaceId).run();

  return jsonOk({ space_id: spaceId, deleted_at: now, updated_at: now });
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd infra/oyster-publish && npm test -- spaces-handler.test.ts
```

Expected: PASS, all 16 tests.

- [ ] **Step 5: Commit**

```bash
git add infra/oyster-publish/src/worker.ts infra/oyster-publish/test/spaces-handler.test.ts
git commit -m "feat(spaces-sync): DELETE /api/spaces/:id sets tombstone, idempotent"
```

---

## Task 5: Local — db.ts adds sync_dirty_at + cloud_synced_at + deleted_at + first-time backfill

**Files:**
- Modify: `server/src/db.ts`

- [ ] **Step 1: Add ALTER TABLE statements**

In `server/src/db.ts`, find the existing spaces ALTER block (lines 50-52: `ALTER TABLE spaces ADD COLUMN parent_id ...`) and append three new statements to the same array. Order matters only insofar as `sync_dirty_at` must exist before the backfill (Step 2) reads it:

```ts
    "ALTER TABLE spaces ADD COLUMN sync_dirty_at INTEGER",
    "ALTER TABLE spaces ADD COLUMN cloud_synced_at INTEGER",
    "ALTER TABLE spaces ADD COLUMN deleted_at INTEGER",
```

The full updated block:

```ts
  for (const sql of [
    "ALTER TABLE artifacts ADD COLUMN group_name TEXT",
    "ALTER TABLE artifacts ADD COLUMN removed_at TEXT",
    "ALTER TABLE artifacts ADD COLUMN source_origin TEXT NOT NULL DEFAULT 'manual'",
    "ALTER TABLE artifacts ADD COLUMN source_ref TEXT",
    "ALTER TABLE spaces ADD COLUMN parent_id TEXT REFERENCES spaces(id)",
    "ALTER TABLE spaces ADD COLUMN summary_title TEXT",
    "ALTER TABLE spaces ADD COLUMN summary_content TEXT",
    "ALTER TABLE spaces ADD COLUMN sync_dirty_at INTEGER",
    "ALTER TABLE spaces ADD COLUMN cloud_synced_at INTEGER",
    "ALTER TABLE spaces ADD COLUMN deleted_at INTEGER",
  ]) {
    try { db.exec(sql); } catch { /* already exists */ }
  }
```

- [ ] **Step 2: One-time promotion backfill — mark every existing live row dirty exactly once**

After the ALTER block, before the `space_paths` table creation, add the backfill:

```ts
  // Promotion backfill: any pre-existing rows (created before sync existed)
  // need to be pushed up on first Pro sign-in. Mark them dirty exactly once
  // by setting sync_dirty_at where it's still NULL — a no-op on subsequent
  // boots since the column will already be populated.
  // Excludes tombstones: deleted_at IS NULL is the live-row guard.
  db.exec(`
    UPDATE spaces
       SET sync_dirty_at = CAST(strftime('%s','now') AS INTEGER) * 1000
     WHERE sync_dirty_at IS NULL AND deleted_at IS NULL
  `);
```

- [ ] **Step 3: Verify migration is idempotent**

Run the existing server test suite:

```bash
cd server && npm test
```

Expected: PASS. The new columns default NULL; the backfill UPDATE on a fresh DB matches zero rows (table is empty); on existing DBs it runs once then no-ops.

- [ ] **Step 4: Commit**

```bash
git add server/src/db.ts
git commit -m "feat(spaces-sync): sync_dirty_at + cloud_synced_at + deleted_at + promotion backfill"
```

---

## Task 6: Local — extend SpaceStore with sync methods + soft-delete

**Files:**
- Modify: `server/src/space-store.ts`
- Create: `server/test/space-store-sync.test.ts`

- [ ] **Step 1: Write failing tests for the new methods**

Create `server/test/space-store-sync.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SqliteSpaceStore } from "../src/space-store.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE spaces (
      id                TEXT PRIMARY KEY,
      display_name      TEXT NOT NULL,
      color             TEXT,
      parent_id         TEXT,
      scan_status       TEXT NOT NULL DEFAULT 'none',
      scan_error        TEXT,
      last_scanned_at   TEXT,
      last_scan_summary TEXT,
      ai_job_status     TEXT,
      ai_job_error      TEXT,
      summary_title     TEXT,
      summary_content   TEXT,
      sync_dirty_at     INTEGER,
      cloud_synced_at   INTEGER,
      deleted_at        INTEGER,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE space_paths (
      space_id TEXT NOT NULL, path TEXT NOT NULL, label TEXT,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (space_id, path)
    );
    CREATE TABLE sources (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL,
      type TEXT NOT NULL, path TEXT NOT NULL,
      label TEXT, added_at TEXT NOT NULL DEFAULT (datetime('now')),
      removed_at TEXT
    );
  `);
  return db;
}

function insertRow(store: SqliteSpaceStore, id: string, opts: Partial<{ displayName: string }> = {}) {
  store.insert({
    id, display_name: opts.displayName ?? id, color: null, parent_id: null,
    scan_status: "none", scan_error: null, last_scanned_at: null,
    last_scan_summary: null, ai_job_status: null, ai_job_error: null,
    summary_title: null, summary_content: null,
  });
}

describe("SqliteSpaceStore — sync methods + soft-delete", () => {
  let db: Database.Database;
  let store: SqliteSpaceStore;

  beforeEach(() => {
    db = makeDb();
    store = new SqliteSpaceStore(db);
  });

  describe("markSyncDirty", () => {
    it("sets sync_dirty_at to the given timestamp", () => {
      insertRow(store, "a");
      store.markSyncDirty("a", 1234);
      const row = db.prepare("SELECT sync_dirty_at FROM spaces WHERE id='a'")
        .get() as { sync_dirty_at: number };
      expect(row.sync_dirty_at).toBe(1234);
    });

    it("defaults to Date.now() when no timestamp is given", () => {
      insertRow(store, "a");
      const before = Date.now();
      store.markSyncDirty("a");
      const after = Date.now();
      const row = db.prepare("SELECT sync_dirty_at FROM spaces WHERE id='a'")
        .get() as { sync_dirty_at: number };
      expect(row.sync_dirty_at).toBeGreaterThanOrEqual(before);
      expect(row.sync_dirty_at).toBeLessThanOrEqual(after);
    });
  });

  describe("getDirtyRows", () => {
    it("excludes rows where sync_dirty_at IS NULL (no sync-relevant change yet)", () => {
      insertRow(store, "a");
      // No markSyncDirty call → row is not dirty per the new predicate.
      expect(store.getDirtyRows()).toEqual([]);
    });

    it("returns rows where sync_dirty_at IS NOT NULL AND cloud_synced_at IS NULL", () => {
      insertRow(store, "a");
      insertRow(store, "b");
      store.markSyncDirty("a", 1000);
      store.markSyncDirty("b", 2000);
      expect(store.getDirtyRows().map(r => r.id).sort()).toEqual(["a", "b"]);
    });

    it("returns rows where sync_dirty_at > cloud_synced_at", () => {
      insertRow(store, "a");
      store.markSyncDirty("a", 5000);
      store.markSynced("a", 3000);  // synced state from before this dirty mark
      expect(store.getDirtyRows().map(r => r.id)).toEqual(["a"]);
    });

    it("excludes rows where cloud_synced_at >= sync_dirty_at", () => {
      insertRow(store, "a");
      store.markSyncDirty("a", 1000);
      store.markSynced("a", 1000);
      expect(store.getDirtyRows()).toEqual([]);
    });

    it("excludes tombstoned rows (those go via getPendingDeletes)", () => {
      insertRow(store, "a");
      store.markSyncDirty("a", 1000);
      store.softDelete("a");
      expect(store.getDirtyRows().map(r => r.id)).toEqual([]);
    });
  });

  describe("getPendingDeletes", () => {
    it("returns soft-deleted rows whose deleted_at is unsynced", () => {
      insertRow(store, "a");
      store.softDelete("a", 5000);
      const pending = store.getPendingDeletes();
      expect(pending.map(r => r.id)).toEqual(["a"]);
    });

    it("excludes soft-deleted rows already synced past their deleted_at", () => {
      insertRow(store, "a");
      store.softDelete("a", 5000);
      store.markSynced("a", 5000);
      expect(store.getPendingDeletes()).toEqual([]);
    });

    it("includes soft-deleted rows where cloud_synced_at < deleted_at (peer state stale)", () => {
      insertRow(store, "a");
      store.markSynced("a", 1000);
      store.softDelete("a", 5000);
      expect(store.getPendingDeletes().map(r => r.id)).toEqual(["a"]);
    });

    it("excludes live rows", () => {
      insertRow(store, "a");
      store.markSyncDirty("a", 1000);
      expect(store.getPendingDeletes()).toEqual([]);
    });
  });

  describe("markSynced", () => {
    it("sets cloud_synced_at to the given timestamp", () => {
      insertRow(store, "a");
      store.markSynced("a", 9999);
      const row = store.getById("a")!;
      expect((row as { cloud_synced_at: number | null }).cloud_synced_at).toBe(9999);
    });
  });

  describe("softDelete", () => {
    it("sets deleted_at to now() by default", () => {
      insertRow(store, "a");
      const before = Date.now();
      store.softDelete("a");
      const row = db.prepare("SELECT deleted_at FROM spaces WHERE id = 'a'")
        .get() as { deleted_at: number };
      expect(row.deleted_at).toBeGreaterThanOrEqual(before);
    });

    it("uses the provided deletedAt timestamp when given (preserves cross-device tombstone provenance)", () => {
      insertRow(store, "a");
      store.softDelete("a", 12345);
      const row = db.prepare("SELECT deleted_at FROM spaces WHERE id = 'a'")
        .get() as { deleted_at: number };
      expect(row.deleted_at).toBe(12345);
    });

    it("excludes the soft-deleted row from getAll() and getById()", () => {
      insertRow(store, "a"); insertRow(store, "b");
      store.softDelete("a");
      expect(store.getAll().map(r => r.id)).toEqual(["b"]);
      expect(store.getById("a")).toBeUndefined();
    });

    it("is idempotent — re-softDelete leaves deleted_at unchanged", () => {
      insertRow(store, "a");
      store.softDelete("a", 5000);
      store.softDelete("a", 9999);  // attempts to overwrite
      const row = db.prepare("SELECT deleted_at FROM spaces WHERE id='a'")
        .get() as { deleted_at: number };
      expect(row.deleted_at).toBe(5000);
    });
  });

  describe("getAllIncludingDeleted", () => {
    it("includes tombstoned rows", () => {
      insertRow(store, "a"); insertRow(store, "b");
      store.softDelete("a");
      expect(store.getAllIncludingDeleted().map(r => r.id).sort()).toEqual(["a", "b"]);
    });
  });

  describe("delete (hard delete — kept for failed-promotion cleanup)", () => {
    it("getAll still excludes hard-deleted rows", () => {
      insertRow(store, "a");
      store.delete("a");
      expect(store.getAll()).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd server && npm test -- space-store-sync.test.ts
```

Expected: FAIL — methods `getDirtyRows`, `markSynced`, `softDelete`, `getAllIncludingDeleted` are not defined.

- [ ] **Step 3: Update SpaceStore interface + add methods to SqliteSpaceStore**

In `server/src/space-store.ts`:

a) Update the `SpaceRow` interface to include the three new columns. Find the `SpaceRow` interface and add three fields (after `summary_content`, before `created_at`):

```ts
  sync_dirty_at: number | null;
  cloud_synced_at: number | null;
  deleted_at: number | null;
```

b) Update the `SpaceStore` interface (around line 30) — add five new methods after `getSourcesByIds`:

```ts
  /** Soft-delete a space. Sets deleted_at to the provided timestamp (or
   *  Date.now()). Idempotent — re-call on an already-deleted row is a no-op
   *  (preserves the original deleted_at). When applying a cross-device
   *  tombstone, pass the cloud's deleted_at to preserve provenance. */
  softDelete(id: string, deletedAt?: number): void;

  /** Mark a row as having a sync-relevant change pending push. Bumped only
   *  by mutations that change synced fields (display_name, color, parent_id,
   *  summary_title, summary_content). NOT bumped by scanner/local-only
   *  mutations — so a scanner pass can't stomp a peer's rename via LWW. */
  markSyncDirty(id: string, dirtyAt?: number): void;

  /** Live rows with pending pushes. Predicate:
   *    deleted_at IS NULL
   *    AND sync_dirty_at IS NOT NULL
   *    AND (cloud_synced_at IS NULL OR sync_dirty_at > cloud_synced_at) */
  getDirtyRows(): SpaceRow[];

  /** Tombstoned rows whose deletion hasn't been confirmed by the cloud.
   *  Predicate:
   *    deleted_at IS NOT NULL
   *    AND (cloud_synced_at IS NULL OR deleted_at > cloud_synced_at) */
  getPendingDeletes(): SpaceRow[];

  /** Mark a row as synced through to the cloud at `cloudUpdatedAt`. For live
   *  rows this is the cloud's updated_at; for confirmed deletes, the cloud's
   *  deleted_at (or 404-acknowledged local deleted_at). */
  markSynced(id: string, cloudUpdatedAt: number): void;

  /** All rows including tombstones. Sync only — surface always uses getAll. */
  getAllIncludingDeleted(): SpaceRow[];
```

c) Replace the `getAll`, `getById`, and `getByDisplayName` prepared statements to filter `deleted_at IS NULL`. Find lines 70-75 and replace:

```ts
      getAll: db.prepare("SELECT * FROM spaces WHERE deleted_at IS NULL ORDER BY display_name"),
      getById: db.prepare("SELECT * FROM spaces WHERE id = ? AND deleted_at IS NULL"),
      getByDisplayName: db.prepare("SELECT * FROM spaces WHERE LOWER(TRIM(display_name)) = LOWER(TRIM(?)) AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1"),
```

d) Add the five new method implementations at the end of the class (before the closing `}`):

```ts
  softDelete(id: string, deletedAt: number = Date.now()): void {
    // Unix ms throughout so the dirty/pending-delete predicates and the
    // cloud column are uniformly comparable. The IS NULL guard makes this
    // idempotent (re-call preserves the original tombstone timestamp).
    this.db.prepare(
      "UPDATE spaces SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
    ).run(deletedAt, id);
  }

  markSyncDirty(id: string, dirtyAt: number = Date.now()): void {
    // Unconditional set — the caller's timestamp is the right one. (We don't
    // guard MAX(existing, dirtyAt) because mutations always represent the
    // user's most recent intent; a stale write would be a bug.)
    this.db.prepare(
      "UPDATE spaces SET sync_dirty_at = ? WHERE id = ?",
    ).run(dirtyAt, id);
  }

  getDirtyRows(): SpaceRow[] {
    return this.db.prepare(`
      SELECT * FROM spaces
       WHERE deleted_at IS NULL
         AND sync_dirty_at IS NOT NULL
         AND (cloud_synced_at IS NULL OR sync_dirty_at > cloud_synced_at)
    `).all() as SpaceRow[];
  }

  getPendingDeletes(): SpaceRow[] {
    return this.db.prepare(`
      SELECT * FROM spaces
       WHERE deleted_at IS NOT NULL
         AND (cloud_synced_at IS NULL OR deleted_at > cloud_synced_at)
    `).all() as SpaceRow[];
  }

  markSynced(id: string, cloudUpdatedAt: number): void {
    this.db.prepare(
      "UPDATE spaces SET cloud_synced_at = ? WHERE id = ?",
    ).run(cloudUpdatedAt, id);
  }

  getAllIncludingDeleted(): SpaceRow[] {
    return this.db.prepare("SELECT * FROM spaces ORDER BY display_name").all() as SpaceRow[];
  }
```

e) The existing `delete` method (cascading hard-delete) stays unchanged — it's still used by failed-promotion cleanup in `createSpaceFromPath`. Soft-delete is a separate path used by `space-service.deleteSpace`.

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd server && npm test -- space-store-sync.test.ts
```

Expected: PASS — all sync-store tests (markSyncDirty, getDirtyRows × 5, getPendingDeletes × 4, markSynced, softDelete × 4, getAllIncludingDeleted, delete).

- [ ] **Step 5: Run full server test suite to confirm no regressions**

```bash
cd server && npm test
```

Expected: PASS. Existing tests don't set `deleted_at` or `sync_dirty_at`, so the new filter clauses are no-ops for them.

- [ ] **Step 6: Commit**

```bash
git add server/src/space-store.ts server/test/space-store-sync.test.ts
git commit -m "feat(spaces-sync): SpaceStore soft-delete + dirty/pending-delete + sync helpers"
```

---

## Task 7: Local — space-sync-service.ts: reconcile() (TDD)

**Files:**
- Create: `server/src/space-sync-service.ts`
- Create: `server/test/space-sync-service.test.ts`

- [ ] **Step 1: Write failing tests for reconcile()**

Create `server/test/space-sync-service.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { SqliteSpaceStore } from "../src/space-store.js";
import { createSpaceSyncService } from "../src/space-sync-service.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE spaces (
      id                TEXT PRIMARY KEY,
      display_name      TEXT NOT NULL,
      color             TEXT,
      parent_id         TEXT,
      scan_status       TEXT NOT NULL DEFAULT 'none',
      scan_error        TEXT,
      last_scanned_at   TEXT,
      last_scan_summary TEXT,
      ai_job_status     TEXT,
      ai_job_error      TEXT,
      summary_title     TEXT,
      summary_content   TEXT,
      sync_dirty_at     INTEGER,
      cloud_synced_at   INTEGER,
      deleted_at        INTEGER,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function insertRow(
  store: SqliteSpaceStore,
  id: string,
  opts: Partial<{ displayName: string; color: string; parentId: string; summaryTitle: string; summaryContent: string }> = {},
) {
  store.insert({
    id,
    display_name: opts.displayName ?? id,
    color: opts.color ?? null,
    parent_id: opts.parentId ?? null,
    scan_status: "none", scan_error: null, last_scanned_at: null,
    last_scan_summary: null, ai_job_status: null, ai_job_error: null,
    summary_title: opts.summaryTitle ?? null,
    summary_content: opts.summaryContent ?? null,
  });
}

const FREE_USER  = { id: "u1", email: "a@a", tier: "free" };
const PRO_USER   = { id: "u1", email: "a@a", tier: "pro" };

describe("createSpaceSyncService — reconcile()", () => {
  let db: Database.Database;
  let store: SqliteSpaceStore;

  beforeEach(() => {
    db = makeDb();
    store = new SqliteSpaceStore(db);
    vi.restoreAllMocks();
  });

  it("returns zeros when no signed-in user (no network call)", async () => {
    const fetchMock = vi.fn();
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => null,
      sessionToken: () => null,
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await svc.reconcile();
    expect(result).toEqual({ pulled: 0, pushed: 0, tombstoned: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns zeros for free-tier users (sync is Pro-only — no network call)", async () => {
    insertRow(store, "work");
    store.markSyncDirty("work", 1000);
    const fetchMock = vi.fn();
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => FREE_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await svc.reconcile();
    expect(result).toEqual({ pulled: 0, pushed: 0, tombstoned: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pulls cloud rows that don't exist locally and inserts them", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/spaces/mine")) {
        return new Response(JSON.stringify({
          spaces: [{
            owner_id: "u1", space_id: "from-cloud", display_name: "From Cloud",
            color: "#3d8aaa", parent_id: null,
            summary_title: null, summary_content: null,
            updated_at: 5000, deleted_at: null, created_at: 5000,
          }],
        }), { status: 200 });
      }
      throw new Error("unexpected fetch: " + url);
    });
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await svc.reconcile();
    expect(result.pulled).toBe(1);
    const row = store.getById("from-cloud")!;
    expect(row.display_name).toBe("From Cloud");
    expect((row as { cloud_synced_at: number | null }).cloud_synced_at).toBe(5000);
  });

  it("updates a local row when cloud.updated_at > local.sync_dirty_at (cloud wins)", async () => {
    insertRow(store, "work", { displayName: "Old Name" });
    store.markSyncDirty("work", 1000);
    store.markSynced("work", 1000);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/spaces/mine")) {
        return new Response(JSON.stringify({
          spaces: [{
            owner_id: "u1", space_id: "work", display_name: "New Name",
            color: null, parent_id: null,
            summary_title: null, summary_content: null,
            updated_at: 9999, deleted_at: null, created_at: 1000,
          }],
        }), { status: 200 });
      }
      throw new Error("unexpected fetch: " + url);
    });
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.reconcile();
    const row = store.getById("work")!;
    expect(row.display_name).toBe("New Name");
    expect((row as { cloud_synced_at: number | null }).cloud_synced_at).toBe(9999);
  });

  it("does NOT pull when local.sync_dirty_at > cloud.updated_at (local wins, will push)", async () => {
    insertRow(store, "work", { displayName: "Local Edit" });
    store.markSyncDirty("work", 9999);
    store.markSynced("work", 1000);

    const puts: Array<{ url: string; body: any }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/spaces/mine")) {
        return new Response(JSON.stringify({
          spaces: [{
            owner_id: "u1", space_id: "work", display_name: "Stale Cloud",
            color: null, parent_id: null,
            summary_title: null, summary_content: null,
            updated_at: 5000, deleted_at: null, created_at: 1000,
          }],
        }), { status: 200 });
      }
      if (url.includes("/api/spaces/work") && init?.method === "PUT") {
        puts.push({ url, body: JSON.parse(init.body as string) });
        return new Response(JSON.stringify({
          space: {
            owner_id: "u1", space_id: "work", display_name: "Local Edit",
            color: null, parent_id: null,
            summary_title: null, summary_content: null,
            updated_at: 9999, deleted_at: null, created_at: 1000,
          },
        }), { status: 200 });
      }
      throw new Error("unexpected fetch: " + url);
    });
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await svc.reconcile();
    expect(result.pulled).toBe(0);
    expect(result.pushed).toBe(1);
    expect(puts[0]!.body.updated_at).toBe(9999);   // wire ts = sync_dirty_at
    expect(store.getById("work")!.display_name).toBe("Local Edit");  // local preserved
  });

  it("soft-deletes a local row when cloud row carries deleted_at, preserving cloud's deleted_at timestamp", async () => {
    insertRow(store, "work");

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/spaces/mine")) {
        return new Response(JSON.stringify({
          spaces: [{
            owner_id: "u1", space_id: "work", display_name: "Work",
            color: null, parent_id: null,
            summary_title: null, summary_content: null,
            updated_at: 9000, deleted_at: 9000, created_at: 1000,
          }],
        }), { status: 200 });
      }
      throw new Error("unexpected fetch: " + url);
    });
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await svc.reconcile();
    expect(result.tombstoned).toBe(1);
    expect(store.getById("work")).toBeUndefined();
    const raw = db.prepare("SELECT deleted_at, cloud_synced_at FROM spaces WHERE id = 'work'")
      .get() as { deleted_at: number; cloud_synced_at: number };
    expect(raw.deleted_at).toBe(9000);              // cloud's tombstone preserved
    expect(raw.cloud_synced_at).toBe(9000);         // marked synced
  });

  it("pushes dirty rows to PUT /api/spaces/:id with sync_dirty_at as wire updated_at", async () => {
    insertRow(store, "work", { displayName: "Work" });
    store.markSyncDirty("work", 7000);

    const puts: Array<{ url: string; body: any }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/spaces/mine")) {
        return new Response(JSON.stringify({ spaces: [] }), { status: 200 });
      }
      if (url.includes("/api/spaces/work") && init?.method === "PUT") {
        puts.push({ url, body: JSON.parse(init.body as string) });
        return new Response(JSON.stringify({
          space: {
            owner_id: "u1", space_id: "work", display_name: "Work",
            color: null, parent_id: null,
            summary_title: null, summary_content: null,
            updated_at: 7000, deleted_at: null, created_at: 7000,
          },
        }), { status: 200 });
      }
      throw new Error("unexpected fetch: " + url);
    });
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await svc.reconcile();
    expect(result.pushed).toBe(1);
    expect(puts[0]!.body.updated_at).toBe(7000);
    const row = store.getById("work")!;
    expect((row as { cloud_synced_at: number | null }).cloud_synced_at).toBe(7000);
  });

  it("pushes pending deletes via DELETE /api/spaces/:id and marks them synced", async () => {
    insertRow(store, "work");
    store.softDelete("work", 8000);

    const deletes: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/spaces/mine")) {
        return new Response(JSON.stringify({ spaces: [] }), { status: 200 });
      }
      if (url.includes("/api/spaces/work") && init?.method === "DELETE") {
        deletes.push(url);
        return new Response(JSON.stringify({
          space_id: "work", deleted_at: 8000, updated_at: 8000,
        }), { status: 200 });
      }
      throw new Error("unexpected fetch: " + url);
    });
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.reconcile();
    expect(deletes).toHaveLength(1);
    const raw = db.prepare("SELECT cloud_synced_at FROM spaces WHERE id = 'work'")
      .get() as { cloud_synced_at: number };
    expect(raw.cloud_synced_at).toBe(8000);
    // Pending-delete predicate is now false → next reconcile won't re-push.
    expect(store.getPendingDeletes()).toEqual([]);
  });

  it("treats DELETE 404 as 'already gone elsewhere' and marks the local tombstone synced", async () => {
    insertRow(store, "work");
    store.softDelete("work", 8000);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/spaces/mine")) {
        return new Response(JSON.stringify({ spaces: [] }), { status: 200 });
      }
      if (url.includes("/api/spaces/work") && init?.method === "DELETE") {
        return new Response(JSON.stringify({ error: "space_not_found" }), { status: 404 });
      }
      throw new Error("unexpected fetch: " + url);
    });
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.reconcile();
    const raw = db.prepare("SELECT cloud_synced_at FROM spaces WHERE id = 'work'")
      .get() as { cloud_synced_at: number };
    expect(raw.cloud_synced_at).toBe(8000);  // local deleted_at acknowledged
    expect(store.getPendingDeletes()).toEqual([]);
  });

  it("is idempotent — back-to-back reconciles with no mutations report 0/0/0", async () => {
    insertRow(store, "work");
    store.markSyncDirty("work", 5000);
    store.markSynced("work", 5000);

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ spaces: [] }), { status: 200 }));
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const first = await svc.reconcile();
    const second = await svc.reconcile();
    expect(first).toEqual({ pulled: 0, pushed: 0, tombstoned: 0 });
    expect(second).toEqual({ pulled: 0, pushed: 0, tombstoned: 0 });
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd server && npm test -- space-sync-service.test.ts
```

Expected: FAIL — module `space-sync-service.js` does not exist.

- [ ] **Step 3: Implement createSpaceSyncService**

Create `server/src/space-sync-service.ts`:

```ts
// space-sync-service.ts — cross-device sync of the local spaces table.
// Spec: docs/superpowers/specs/2026-05-06-spaces-sync-spinout-design.md
//
// Wedge of #319 (R1). Pattern: dirty-row push + pending-delete sweep + full
// pull on reconcile, fire-and-forget pushOne/pushDelete after each mutation.
// Pro-only — sync is gated on user.tier === "pro".
//
// IMPORTANT: this is the FIRST instance of cross-device row-sync. Before
// replicating this shape for memory (#318), session metadata, or artefact
// bytes (R7), evaluate PowerSync / ElectricSQL / Replicache / object-
// storage-only designs. See project_sync_build_vs_lease memory.

import type Database from "better-sqlite3";
import type { SpaceStore, SpaceRow } from "./space-store.js";

export interface SyncUser {
  id: string;
  email: string;
  tier: string;
}

export interface SpaceSyncDeps {
  db: Database.Database;
  store: SpaceStore;
  currentUser: () => SyncUser | null;
  sessionToken: () => string | null;
  workerBase: string;
  fetch: typeof fetch;
}

export interface SpaceSyncService {
  /** Pull cloud → local, then push live dirty rows, then push pending
   *  deletes. Idempotent. Called on sign-in (BEFORE backfillPublications,
   *  so the headline _cloud-fallback fix is immediate) and on app start
   *  when signed in. Pro-only — returns zeros for free / signed-out. */
  reconcile(): Promise<{ pulled: number; pushed: number; tombstoned: number }>;

  /** Fire-and-forget push for one row after a local mutation. Swallows
   *  network errors with a console.warn; the next reconcile() retries.
   *  Pro-only — no-op for free / signed-out. */
  pushOne(spaceId: string): Promise<void>;

  /** Fire-and-forget DELETE for a space the local server just soft-deleted.
   *  Marks the local tombstone synced on 200/404. Pro-only. */
  pushDelete(spaceId: string): Promise<void>;
}

interface CloudSpace {
  owner_id: string;
  space_id: string;
  display_name: string;
  color: string | null;
  parent_id: string | null;
  summary_title: string | null;
  summary_content: string | null;
  updated_at: number;
  deleted_at: number | null;
  created_at: number;
}

interface CloudDeleteResponse {
  space_id: string;
  deleted_at: number;
  updated_at: number;
}

/** Pro tier check. Spec: R1 (this wedge) is Pro-only per the requirements doc
 *  tier mapping. Keep in one place so it's easy to change if the gate moves. */
function isProSession(deps: SpaceSyncDeps): { user: SyncUser; token: string } | null {
  const user = deps.currentUser();
  const token = deps.sessionToken();
  if (!user || !token || user.tier !== "pro") return null;
  return { user, token };
}

export function createSpaceSyncService(deps: SpaceSyncDeps): SpaceSyncService {
  return {
    async reconcile() {
      const session = isProSession(deps);
      if (!session) return { pulled: 0, pushed: 0, tombstoned: 0 };

      // ── Pull ──
      let res: Response;
      try {
        res = await deps.fetch(`${deps.workerBase}/api/spaces/mine`, {
          headers: { Cookie: `oyster_session=${session.token}` },
        });
      } catch (err) {
        console.warn("[spaces] reconcile pull failed:", err);
        return { pulled: 0, pushed: 0, tombstoned: 0 };
      }
      if (!res.ok) {
        console.warn(`[spaces] reconcile pull non-ok ${res.status}`);
        return { pulled: 0, pushed: 0, tombstoned: 0 };
      }

      const body = await res.json().catch(() => null) as { spaces?: CloudSpace[] } | null;
      const cloudRows = body?.spaces ?? [];

      let pulled = 0;
      let tombstoned = 0;

      // Raw SQL for the upsert path because store.update() filters by
      // UPDATABLE_COLUMNS and we need to set cloud_synced_at directly.
      // Note: NOT touching sync_dirty_at — leave it whatever it was. The
      // dirty predicate naturally goes clean because cloud_synced_at >=
      // sync_dirty_at after this write.
      const upsertStmt = deps.db.prepare(`
        INSERT INTO spaces
          (id, display_name, color, parent_id, summary_title, summary_content,
           scan_status, cloud_synced_at, updated_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'none', ?, datetime('now'), datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          display_name    = excluded.display_name,
          color           = excluded.color,
          parent_id       = excluded.parent_id,
          summary_title   = excluded.summary_title,
          summary_content = excluded.summary_content,
          cloud_synced_at = excluded.cloud_synced_at,
          updated_at      = datetime('now')
      `);

      for (const cloud of cloudRows) {
        if (cloud.deleted_at !== null) {
          // Tombstone application — preserve cloud's deleted_at as local's
          // deleted_at (cross-device tombstone provenance), and mark synced
          // so the pending-delete sweep doesn't re-push.
          const existing = deps.db.prepare(
            "SELECT id, deleted_at FROM spaces WHERE id = ?",
          ).get(cloud.space_id) as { id: string; deleted_at: number | null } | undefined;
          if (existing && existing.deleted_at === null) {
            deps.store.softDelete(cloud.space_id, cloud.deleted_at);
            tombstoned++;
          }
          // Mark synced unconditionally (also covers the case where local
          // had its own tombstone and they happen to match).
          if (existing) deps.store.markSynced(cloud.space_id, cloud.deleted_at);
          continue;
        }

        const existing = deps.db.prepare(
          "SELECT sync_dirty_at, cloud_synced_at FROM spaces WHERE id = ? AND deleted_at IS NULL",
        ).get(cloud.space_id) as { sync_dirty_at: number | null; cloud_synced_at: number | null } | undefined;

        if (!existing) {
          upsertStmt.run(
            cloud.space_id, cloud.display_name, cloud.color, cloud.parent_id,
            cloud.summary_title, cloud.summary_content, cloud.updated_at,
          );
          pulled++;
        } else {
          // LWW pull rule: cloud wins iff local has no dirty mark, OR cloud
          // is newer than local's dirty mark. Otherwise push step takes over.
          const localDirty = existing.sync_dirty_at;
          if (localDirty === null || cloud.updated_at > localDirty) {
            upsertStmt.run(
              cloud.space_id, cloud.display_name, cloud.color, cloud.parent_id,
              cloud.summary_title, cloud.summary_content, cloud.updated_at,
            );
            pulled++;
          }
          // else: local has unsynced changes newer than cloud; push handles it.
        }
      }

      // ── Push live dirty rows ──
      const dirty = deps.store.getDirtyRows();
      let pushed = 0;
      for (const row of dirty) {
        const ok = await pushRow(deps, session.token, row);
        if (ok) pushed++;
      }

      // ── Push pending deletes ──
      const pending = deps.store.getPendingDeletes();
      for (const row of pending) {
        await pushRowDelete(deps, session.token, row);
      }

      return { pulled, pushed, tombstoned };
    },

    async pushOne(spaceId) {
      const session = isProSession(deps);
      if (!session) return;
      const row = deps.db.prepare(
        "SELECT * FROM spaces WHERE id = ? AND deleted_at IS NULL",
      ).get(spaceId) as SpaceRow | undefined;
      if (!row) return;
      const dirtyAt = (row as { sync_dirty_at: number | null }).sync_dirty_at;
      const synced  = (row as { cloud_synced_at: number | null }).cloud_synced_at;
      // Clean if no dirty mark, or already synced past it.
      if (dirtyAt === null) return;
      if (synced !== null && synced >= dirtyAt) return;
      await pushRow(deps, session.token, row);
    },

    async pushDelete(spaceId) {
      const session = isProSession(deps);
      if (!session) return;
      // Read the local tombstone row (including deleted) so we know what
      // deleted_at to use if the worker says 404.
      const row = deps.db.prepare(
        "SELECT id, deleted_at, cloud_synced_at FROM spaces WHERE id = ?",
      ).get(spaceId) as { id: string; deleted_at: number | null; cloud_synced_at: number | null } | undefined;
      if (!row || row.deleted_at === null) return;
      await pushRowDelete(deps, session.token, row as unknown as SpaceRow);
    },
  };
}

async function pushRow(deps: SpaceSyncDeps, token: string, row: SpaceRow): Promise<boolean> {
  const dirtyAt = (row as { sync_dirty_at: number | null }).sync_dirty_at;
  if (dirtyAt === null) return false;  // shouldn't happen — caller filters

  let res: Response;
  try {
    res = await deps.fetch(`${deps.workerBase}/api/spaces/${encodeURIComponent(row.id)}`, {
      method: "PUT",
      headers: {
        Cookie: `oyster_session=${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        display_name:    row.display_name,
        color:           row.color,
        parent_id:       row.parent_id,
        summary_title:   row.summary_title,
        summary_content: row.summary_content,
        // Wire LWW key = sync_dirty_at (timestamp of the last sync-relevant
        // mutation), NOT the row's general-purpose updated_at.
        updated_at: dirtyAt,
      }),
    });
  } catch (err) {
    console.warn(`[spaces] push ${row.id} failed:`, err);
    return false;
  }

  if (res.status === 410) {
    // Cloud has tombstoned this row. Apply locally and stop dirty-retrying.
    deps.store.softDelete(row.id);
    return false;
  }
  if (!res.ok) {
    console.warn(`[spaces] push ${row.id} non-ok ${res.status}`);
    return false;
  }

  const body = await res.json().catch(() => null) as { space?: { updated_at?: number } } | null;
  const cloudUpdated = body?.space?.updated_at ?? dirtyAt;
  deps.store.markSynced(row.id, cloudUpdated);
  return true;
}

async function pushRowDelete(deps: SpaceSyncDeps, token: string, row: SpaceRow): Promise<void> {
  const localDeletedAt = (row as { deleted_at: number | null }).deleted_at ?? Date.now();
  let res: Response;
  try {
    res = await deps.fetch(
      `${deps.workerBase}/api/spaces/${encodeURIComponent(row.id)}`,
      { method: "DELETE", headers: { Cookie: `oyster_session=${token}` } },
    );
  } catch (err) {
    console.warn(`[spaces] delete ${row.id} failed:`, err);
    return;
  }

  if (res.status === 404) {
    // Cloud has no record — local tombstone is the only state; consider it
    // acknowledged so the pending-delete sweep stops re-trying.
    deps.store.markSynced(row.id, localDeletedAt);
    return;
  }
  if (!res.ok) {
    console.warn(`[spaces] delete ${row.id} non-ok ${res.status}`);
    return;
  }
  const body = await res.json().catch(() => null) as CloudDeleteResponse | null;
  const cloudDeletedAt = body?.deleted_at ?? localDeletedAt;
  deps.store.markSynced(row.id, cloudDeletedAt);
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd server && npm test -- space-sync-service.test.ts
```

Expected: PASS — all 10 reconcile tests (signed-out no-op, free-tier no-op, pull insert, pull update, local-wins-no-pull, tombstone preserves cloud.deleted_at, push dirty with sync_dirty_at, push pending delete, DELETE 404 acknowledged, idempotent).

- [ ] **Step 5: Commit**

```bash
git add server/src/space-sync-service.ts server/test/space-sync-service.test.ts
git commit -m "feat(spaces-sync): SpaceSyncService — Pro-gated pull/push/delete with LWW"
```

---

## Task 8: Local — pushOne() additional tests + 410 handling

**Files:**
- Modify: `server/test/space-sync-service.test.ts`

- [ ] **Step 1: Append failing pushOne tests**

Append to `space-sync-service.test.ts`:

```ts
describe("createSpaceSyncService — pushOne()", () => {
  let db: Database.Database;
  let store: SqliteSpaceStore;

  beforeEach(() => {
    db = makeDb();
    store = new SqliteSpaceStore(db);
    vi.restoreAllMocks();
  });

  it("does nothing when user is signed out", async () => {
    insertRow(store, "work");
    store.markSyncDirty("work", 1000);
    const fetchMock = vi.fn();
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => null,
      sessionToken: () => null,
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushOne("work");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing for free-tier users (Pro-only feature)", async () => {
    insertRow(store, "work");
    store.markSyncDirty("work", 1000);
    const fetchMock = vi.fn();
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => FREE_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushOne("work");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when row is missing", async () => {
    const fetchMock = vi.fn();
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushOne("ghost");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when row has no sync_dirty_at (no sync-relevant change)", async () => {
    insertRow(store, "work");
    // No markSyncDirty — row was inserted but not flagged for sync.
    const fetchMock = vi.fn();
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushOne("work");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when row is already clean (cloud_synced_at >= sync_dirty_at)", async () => {
    insertRow(store, "work");
    store.markSyncDirty("work", 1000);
    store.markSynced("work", 1000);
    const fetchMock = vi.fn();
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushOne("work");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PUTs a dirty row with sync_dirty_at as wire updated_at, updates cloud_synced_at on 200", async () => {
    insertRow(store, "work");
    store.markSyncDirty("work", 6000);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      const body = JSON.parse(init!.body as string) as { updated_at: number };
      expect(body.updated_at).toBe(6000);
      return new Response(JSON.stringify({
        space: {
          owner_id: "u1", space_id: "work", display_name: "work",
          color: null, parent_id: null,
          summary_title: null, summary_content: null,
          updated_at: 6000, deleted_at: null, created_at: 6000,
        },
      }), { status: 200 });
    });
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushOne("work");
    expect(fetchMock).toHaveBeenCalledOnce();
    const row = store.getById("work")!;
    expect((row as { cloud_synced_at: number | null }).cloud_synced_at).toBe(6000);
  });

  it("on 410, soft-deletes the local row (deletion wins over stale rename)", async () => {
    insertRow(store, "work");
    store.markSyncDirty("work", 1000);
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: "space_tombstoned" }), { status: 410 },
    ));
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushOne("work");
    expect(store.getById("work")).toBeUndefined();
  });

  it("swallows network errors (console.warn, no throw)", async () => {
    insertRow(store, "work");
    store.markSyncDirty("work", 1000);
    const fetchMock = vi.fn(async () => { throw new Error("offline"); });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(svc.pushOne("work")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests, verify pass (the implementation from Task 7 already covers these)**

```bash
cd server && npm test -- space-sync-service.test.ts
```

Expected: PASS — all 18 tests (10 reconcile + 8 pushOne).

If any test fails, fix in `space-sync-service.ts` and re-run.

- [ ] **Step 3: Commit**

```bash
git add server/test/space-sync-service.test.ts
git commit -m "test(spaces-sync): pushOne() — Pro gate, dirty marker, 410 tombstone, network error"
```

---

## Task 9: Local — wire pushOne into SpaceService mutations

**Files:**
- Modify: `server/src/space-service.ts`
- Modify: existing `server/test/` (no new test file required — manual smoke + acceptance test in Task 11 covers the wire)

- [ ] **Step 1: Inject SpaceSyncService into SpaceService**

In `server/src/space-service.ts`, update the imports and constructor:

a) Add import near the top:

```ts
import type { SpaceSyncService } from "./space-sync-service.js";
```

b) Update the constructor signature to accept the new dependency (optional so existing call sites keep compiling until Task 10 wires it):

```ts
  constructor(
    private spaceStore: SpaceStore,
    private artifactStore: ArtifactStore,
    private artifactService: ArtifactService,
    private sessionStore: SessionStore,
    private spaceSync?: SpaceSyncService,
  ) {}
```

c) After every mutation that changes a *synced* field (display_name, color, parent_id, summary_title, summary_content), call `markSyncDirty()` THEN fire-and-forget `pushOne()`. The two calls are paired — `markSyncDirty()` is what makes the row visible to `getDirtyRows()`, and `pushOne()` is the immediate push attempt.

In `createSpace`, after `this.spaceStore.insert(...)`, before the `return`:

```ts
    this.spaceStore.markSyncDirty(id);
    void this.spaceSync?.pushOne(id);
```

In `setSummary`, after `this.spaceStore.update(id, { summary_title: title, summary_content: content })`:

```ts
    this.spaceStore.markSyncDirty(id);
    void this.spaceSync?.pushOne(id);
```

In `updateSpace`, after `this.spaceStore.update(id, dbFields)`:

```ts
    this.spaceStore.markSyncDirty(id);
    void this.spaceSync?.pushOne(id);
```

In `deleteSpace`, replace the existing `this.spaceStore.delete(id)` (the very last line of the method) with the soft-delete + cloud push pattern:

```ts
    // Soft-delete locally; cloud propagates the tombstone via pushDelete.
    // (pushDelete is fire-and-forget; the pending-delete sweep in the next
    // reconcile() retries on failure.)
    this.spaceStore.softDelete(id);
    void this.spaceSync?.pushDelete(id);
```

> **WHY soft-delete instead of hard-delete here?** Hard-delete loses the row entirely, which means the cloud DELETE isn't retried on offline → online. Soft-delete keeps the local row marked tombstoned (filtered out of getAll/getById, same effect on the surface) and lets `pushDelete()` or the pending-delete sweep in `reconcile()` propagate without re-discovering the deletion.

> **CRITICAL — do NOT call `markSyncDirty()` in `scanSpace`.** scanSpace mutates `scan_status` / `scan_error` / `last_scanned_at` / `last_scan_summary` / `ai_job_*` — all device-local fields. Marking the row dirty would push a PUT with stale synced fields to the cloud, potentially overwriting a peer's legitimate rename. The `sync_dirty_at` column exists precisely to prevent this. Leave `scanSpace` untouched; it does not interact with sync at all.

> **Known limit — soft-delete and orphaned sources/space_paths:** soft-deleting a space (vs. hard-delete) leaves its `sources` and `space_paths` rows behind. Direct readers (e.g. `spaceStore.getSources(spaceId)`) won't filter on `spaces.deleted_at IS NULL` — they take the spaceId as given. In practice, callers reach `getSources` only via paths that first checked the space exists via `getById` (which now filters), so the leak is contained. If a backend code path is added that reads `sources` without going through `getById` first, it should join on `spaces.deleted_at IS NULL`. Follow-up: cascade soft-delete to sources/space_paths (or hard-delete them at soft-delete time, since they're device-local anyway).

- [ ] **Step 2: Add pushDelete tests to space-sync-service.test.ts**

Append a sibling `describe("pushDelete()")` block:

```ts
describe("createSpaceSyncService — pushDelete()", () => {
  let db: Database.Database;
  let store: SqliteSpaceStore;

  beforeEach(() => {
    db = makeDb();
    store = new SqliteSpaceStore(db);
    vi.restoreAllMocks();
  });

  it("does nothing when user is signed out", async () => {
    insertRow(store, "work");
    store.softDelete("work", 1000);
    const fetchMock = vi.fn();
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => null,
      sessionToken: () => null,
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushDelete("work");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing for free-tier users (Pro-only)", async () => {
    insertRow(store, "work");
    store.softDelete("work", 1000);
    const fetchMock = vi.fn();
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => FREE_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushDelete("work");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when row is not soft-deleted (live row)", async () => {
    insertRow(store, "work");
    const fetchMock = vi.fn();
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushDelete("work");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DELETEs the cloud row and marks the local tombstone synced on 200", async () => {
    insertRow(store, "work");
    store.softDelete("work", 5000);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe("DELETE");
      expect(url).toMatch(/\/api\/spaces\/work$/);
      return new Response(JSON.stringify({
        space_id: "work", deleted_at: 5000, updated_at: 5000,
      }), { status: 200 });
    });
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushDelete("work");
    expect(fetchMock).toHaveBeenCalledOnce();
    const raw = db.prepare("SELECT cloud_synced_at FROM spaces WHERE id = 'work'")
      .get() as { cloud_synced_at: number };
    expect(raw.cloud_synced_at).toBe(5000);
    expect(store.getPendingDeletes()).toEqual([]);
  });

  it("on 404 (row never made it to cloud), marks the local tombstone synced anyway", async () => {
    insertRow(store, "work");
    store.softDelete("work", 5000);
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: "space_not_found" }), { status: 404 },
    ));
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(svc.pushDelete("work")).resolves.toBeUndefined();
    const raw = db.prepare("SELECT cloud_synced_at FROM spaces WHERE id = 'work'")
      .get() as { cloud_synced_at: number };
    expect(raw.cloud_synced_at).toBe(5000);
    expect(store.getPendingDeletes()).toEqual([]);
  });

  it("swallows network errors and leaves the tombstone pending (will retry next reconcile)", async () => {
    insertRow(store, "work");
    store.softDelete("work", 5000);
    const fetchMock = vi.fn(async () => { throw new Error("offline"); });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => PRO_USER,
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(svc.pushDelete("work")).resolves.toBeUndefined();
    // Tombstone remains pending — no cloud_synced_at update on network error.
    expect(store.getPendingDeletes().map(r => r.id)).toEqual(["work"]);
  });
});
```

- [ ] **Step 3: Run server tests**

```bash
cd server && npm test
```

Expected: PASS — sync service has 24 tests (10 reconcile + 8 pushOne + 6 pushDelete); space-store-sync 18 tests stays green; existing tests untouched.

- [ ] **Step 4: Commit**

```bash
git add server/src/space-service.ts server/src/space-sync-service.ts server/test/space-sync-service.test.ts
git commit -m "feat(spaces-sync): wire pushOne/pushDelete into SpaceService mutations"
```

---

## Task 10: Local — wire reconcile into auth + boot (index.ts)

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: Construct SpaceSyncService and pass to SpaceService**

In `server/src/index.ts`:

a) Add import near the top with the other server-src imports:

```ts
import { createSpaceSyncService } from "./space-sync-service.js";
```

b) Find the `spaceService` construction (line 267):

```ts
const spaceService = new SpaceService(spaceStore, store, artifactService, sessionStore);
```

Replace with construction that creates spaceSync first, then injects it:

```ts
// spaceSync provides cross-device mirror of the spaces table to D1.
// Constructed before spaceService so the latter can fire pushOne/pushDelete
// after each mutation. Same auth bridge as publishService.
const spaceSync = createSpaceSyncService({
  db,
  store: spaceStore,
  currentUser: () => {
    const u = authService.getState().user;
    return u ? { id: u.id, email: u.email, tier: u.tier } : null;
  },
  sessionToken: () => authService.getState().sessionToken,
  workerBase: WORKER_BASE,
  fetch,
});
const spaceService = new SpaceService(spaceStore, store, artifactService, sessionStore, spaceSync);
```

> **WAIT** — `authService` is constructed AFTER `spaceService` in the current order (lines 267 vs 276). Reorder: hoist `authService` construction so spaceSync (which captures it) can be wired immediately. Move the `authService` block (lines 271-284) above `spaceService` (line 267). Reading order should become: spaceStore → artifactService → authService (with persisted-session validation) → spaceSync → spaceService.

Concrete edit: cut the block

```ts
const authService = new AuthService(CONFIG_DIR);
authService.onAuthChanged((state) => { ... });
void authService.validatePersistedSession();
```

…and paste it just *above* the original `spaceService` line. Then add the `spaceSync` construction immediately after `authService`, then the modified `spaceService` line.

c) Wire reconcile to run BEFORE backfillPublications. Find the existing block (lines 329-338):

```ts
authService.onAuthChanged(() => {
  void publishService.backfillPublications().then((r) => logBackfill("auth-backfill", r));
});
if (authService.getState().user) {
  void publishService.backfillPublications().then((r) => logBackfill("startup-backfill", r));
}
```

Replace with:

```ts
async function syncOnAuth(label: string): Promise<void> {
  // Spaces FIRST — the headline fix is that published-artefact ghosts resolve
  // to real spaces, not _cloud. Doing publications first defeats that.
  try {
    const sr = await spaceSync.reconcile();
    console.log(`[spaces] ${label}: pulled=${sr.pulled} pushed=${sr.pushed} tombstoned=${sr.tombstoned}`);
    if (sr.pulled > 0 || sr.tombstoned > 0) {
      // Notify the surface so any space pills update immediately.
      broadcastUiEvent({ version: 1, command: "artifact_changed", payload: { id: null } });
    }
  } catch (err) {
    console.warn(`[spaces] ${label} failed:`, err);
  }
  // Then publications (existing behaviour).
  const pr = await publishService.backfillPublications();
  logBackfill(label, pr);
}

authService.onAuthChanged(() => { void syncOnAuth("auth"); });
if (authService.getState().user) {
  void syncOnAuth("startup");
}
```

- [ ] **Step 2: Build server, fix any TypeScript errors**

```bash
cd server && npm run build
```

Expected: PASS. If there's a TS error about `SpaceService` constructor arity, double-check Task 9 made `spaceSync` optional in the signature (`spaceSync?: SpaceSyncService`).

- [ ] **Step 3: Manual smoke test**

```bash
npm run dev
```

Open `http://localhost:7337`. Sign in as a Pro user. Watch the server console for:

```
[spaces] auth: pulled=N pushed=M tombstoned=K
[publish] auth-backfill: mirrored=... skipped=...
```

Both should appear, in that order, on every sign-in.

- [ ] **Step 4: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(spaces-sync): wire spaceSync.reconcile() into sign-in (BEFORE publish backfill)"
```

---

## Task 11: Cross-device manual verification

**Files:** None (manual checklist).

This task replaces an automated end-to-end test. The unit tests across Tasks 2–8 cover the slices; the cross-device flow is best smoke-tested by hand for the wedge.

- [ ] **Step 1: Set up two dev environments pointing at the same Pro account**

Use a primary terminal for "Machine A" and a second `userland` directory for "Machine B":

```bash
# Terminal 1 — Machine A
npm run dev   # Vite at 7337, server at 3333, userland at ./userland

# Terminal 2 — Machine B (separate userland)
USERLAND_DIR=$(mktemp -d) PORT=3334 VITE_PORT=7338 npm run dev
```

Sign into both with the same Pro Google account. Sign-in flow opens the auth worker; same email both times.

- [ ] **Step 2: Headline fix — published-artefact ghost resolves to real space on Machine B**

On Machine A:
1. Create a space "Work".
2. Publish any artefact in space "Work".

On Machine B:
1. Sign in (or refresh — sign-in fires reconcile + backfill).
2. The published-artefact ghost in the surface should show space pill **"Work"**, NOT the generic `_cloud` bucket.

Pass criterion: pill colour matches "Work" (per A's palette), and clicking the pill filters to that space.

- [ ] **Step 3: Rename propagates**

On Machine A:
1. Rename "Work" → "Work Stuff" (right-click pill → rename, or via API).

On Machine B:
1. Trigger a refresh/sign-in cycle.
2. Pill should display "Work Stuff".

- [ ] **Step 4: Soft-delete propagates**

On Machine A:
1. Delete the "Work Stuff" space.

On Machine B:
1. Refresh.
2. Pill disappears from the surface; orphaned artefacts move to "home" per existing `deleteSpace` logic.

- [ ] **Step 5: Free user / signed-out — no cloud writes**

Sign out on Machine A. Create a space "Throwaway". Inspect D1 (or check `[spaces]` logs — none should be emitted). The space should NOT appear in `synced_spaces`.

- [ ] **Step 6: Document any failures as follow-up issues, then commit a manual log**

If anything fails the above, file a follow-up issue. Otherwise, no commit needed for this task — it's verification.

---

## Task 12: CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add Changed entry under [Unreleased]**

Open `CHANGELOG.md`. Find the `[Unreleased]` section (top of file). If it doesn't have a `### Changed` subsection, add one. Append a single bullet:

```markdown
### Changed
- **Spaces now sync across signed-in devices.** Pro users see the same set of spaces — name, hierarchy, summary — on every device they sign into. Published artefacts on a fresh device resolve to their real space instead of a generic "Cloud" bucket.
```

(Per `feedback_changelog_style`: outcome, not internals. No mention of D1, dirty rows, sync service, etc.)

- [ ] **Step 2: Regenerate the rendered changelog**

```bash
npm run build:changelog
```

Expected: refreshes `docs/changelog.html` with the new entry.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md docs/changelog.html
git commit -m "docs(changelog): spaces sync entry"
```

---

## Final verification

Before opening the PR:

- [ ] `cd server && npm test` — all green.
- [ ] `cd infra/oyster-publish && npm test` — all green.
- [ ] `npm run build` from repo root — full build (web + server) succeeds.
- [ ] Manual cross-device walkthrough (Task 11) all pass.
- [ ] Branch is `spaces-sync-spinout` (already created during brainstorm).
- [ ] Spec doc (`docs/superpowers/specs/2026-05-06-spaces-sync-spinout-design.md`) is on the branch.
- [ ] Issue #406 referenced in PR title or body.

PR title: `feat(spaces-sync): cloud-mirror the spaces table (closes #406)`.
