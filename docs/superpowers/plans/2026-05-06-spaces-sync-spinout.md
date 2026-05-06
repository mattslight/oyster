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

- [ ] **Step 1: Write the migration file**

Create `infra/auth-worker/migrations/0006_synced_spaces.sql`:

```sql
-- 0006_synced_spaces.sql — cross-device mirror of the local spaces table.
-- Spec: docs/superpowers/specs/2026-05-06-spaces-sync-spinout-design.md
-- Wedge of #319 (R1). Used by the local server's space-sync-service to
-- reconcile per-user spaces across devices. Tombstones propagate deletes.

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
      const spaceId = url.pathname.slice("/api/spaces/".length);
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

  if (typeof body.display_name !== "string" || body.display_name.length === 0) {
    return jsonError(400, "invalid_metadata");
  }
  if (typeof body.updated_at !== "number" || !Number.isFinite(body.updated_at)) {
    return jsonError(400, "invalid_metadata");
  }
  // Optional fields — null is allowed; unset becomes null.
  const color           = body.color           === undefined ? null : (body.color           as string | null);
  const parentId        = body.parent_id       === undefined ? null : (body.parent_id       as string | null);
  const summaryTitle    = body.summary_title   === undefined ? null : (body.summary_title   as string | null);
  const summaryContent  = body.summary_content === undefined ? null : (body.summary_content as string | null);
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
      body.display_name, color, parentId,
      summaryTitle, summaryContent, incomingUpdated,
      user.id, spaceId,
    ).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO synced_spaces
       (owner_id, space_id, display_name, color, parent_id,
        summary_title, summary_content, updated_at, deleted_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).bind(
      user.id, spaceId, body.display_name, color, parentId,
      summaryTitle, summaryContent, incomingUpdated, now,
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
      const spaceId = url.pathname.slice("/api/spaces/".length);
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

## Task 5: Local — db.ts adds cloud_synced_at + deleted_at to spaces

**Files:**
- Modify: `server/src/db.ts`

- [ ] **Step 1: Add ALTER TABLE statements**

In `server/src/db.ts`, find the existing spaces ALTER block (lines 50-52: `ALTER TABLE spaces ADD COLUMN parent_id ...`) and append two new statements to the same array:

```ts
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
    "ALTER TABLE spaces ADD COLUMN cloud_synced_at INTEGER",
    "ALTER TABLE spaces ADD COLUMN deleted_at INTEGER",
  ]) {
    try { db.exec(sql); } catch { /* already exists */ }
  }
```

- [ ] **Step 2: Verify migration is idempotent**

Run the existing server test suite — many tests construct fresh DBs via `initDb`:

```bash
cd server && npm test
```

Expected: PASS (no test broken; the new columns just default NULL on existing rows).

- [ ] **Step 3: Commit**

```bash
git add server/src/db.ts
git commit -m "feat(spaces-sync): add cloud_synced_at + deleted_at to local spaces table"
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

  describe("getDirtyRows", () => {
    it("returns rows where cloud_synced_at IS NULL", () => {
      insertRow(store, "a");
      insertRow(store, "b");
      expect(store.getDirtyRows().map(r => r.id).sort()).toEqual(["a", "b"]);
    });

    it("returns rows where updated_at > cloud_synced_at", () => {
      insertRow(store, "a");
      // Mark as synced 1s ago, then bump updated_at to now.
      db.prepare("UPDATE spaces SET cloud_synced_at = ? WHERE id = 'a'").run(Date.now() - 60_000);
      db.prepare("UPDATE spaces SET updated_at = datetime('now') WHERE id = 'a'").run();
      const dirty = store.getDirtyRows();
      expect(dirty.map(r => r.id)).toEqual(["a"]);
    });

    it("excludes rows where cloud_synced_at >= updated_at", () => {
      insertRow(store, "a");
      // Mark synced AT or AFTER current updated_at — the row is clean.
      db.prepare("UPDATE spaces SET cloud_synced_at = ? WHERE id = 'a'").run(Date.now() + 60_000);
      expect(store.getDirtyRows()).toEqual([]);
    });

    it("excludes tombstoned rows (those go via the delete-push path)", () => {
      insertRow(store, "a");
      store.softDelete("a");
      expect(store.getDirtyRows().map(r => r.id)).toEqual([]);
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
    it("sets deleted_at to now", () => {
      insertRow(store, "a");
      const before = Date.now();
      store.softDelete("a");
      const row = db.prepare("SELECT deleted_at FROM spaces WHERE id = 'a'")
        .get() as { deleted_at: number };
      expect(row.deleted_at).toBeGreaterThanOrEqual(before);
    });

    it("excludes the soft-deleted row from getAll() and getById()", () => {
      insertRow(store, "a"); insertRow(store, "b");
      store.softDelete("a");
      expect(store.getAll().map(r => r.id)).toEqual(["b"]);
      expect(store.getById("a")).toBeUndefined();
    });

    it("is idempotent — re-softDelete leaves deleted_at unchanged", () => {
      insertRow(store, "a");
      store.softDelete("a");
      const first = (db.prepare("SELECT deleted_at FROM spaces WHERE id='a'")
        .get() as { deleted_at: number }).deleted_at;
      store.softDelete("a");
      const second = (db.prepare("SELECT deleted_at FROM spaces WHERE id='a'")
        .get() as { deleted_at: number }).deleted_at;
      expect(second).toBe(first);
    });
  });

  describe("getAllIncludingDeleted", () => {
    it("includes tombstoned rows", () => {
      insertRow(store, "a"); insertRow(store, "b");
      store.softDelete("a");
      expect(store.getAllIncludingDeleted().map(r => r.id).sort()).toEqual(["a", "b"]);
    });
  });

  describe("delete (hard delete)", () => {
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

a) Update the `SpaceRow` interface to include the two new columns. Find:

```ts
export interface SpaceRow {
  id: string;
  display_name: string;
  ...
  updated_at: string;
}
```

Add two fields:

```ts
  cloud_synced_at: number | null;
  deleted_at: number | null;
```

b) Update the `SpaceStore` interface (around line 30) — add four new methods after `getSourcesByIds`:

```ts
  /** Soft-delete a space. Sets deleted_at. Future getAll/getById excludes it.
   *  Idempotent — re-calling on an already-deleted row is a no-op. */
  softDelete(id: string): void;
  /** All rows the local server is dirty against the cloud, by the predicate
   *  cloud_synced_at IS NULL OR updated_at > cloud_synced_at. Excludes
   *  tombstoned rows (those push via the DELETE endpoint, not PUT). */
  getDirtyRows(): SpaceRow[];
  /** Mark a row as synced through to the cloud at `cloudUpdatedAt` (the
   *  timestamp the cloud row carries — the LWW comparison key). */
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

d) Add the four new method implementations at the end of the class (before the closing `}`):

```ts
  softDelete(id: string): void {
    // datetime('now') returns text; the cloud column is unix ms. We use unix
    // ms here too so dirty/sync timestamps are uniformly comparable across
    // the cloud row, the local soft-delete, and cloud_synced_at.
    this.db.prepare(
      "UPDATE spaces SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
    ).run(Date.now(), id);
  }

  getDirtyRows(): SpaceRow[] {
    // updated_at on spaces is the legacy `datetime('now')` text format —
    // compare via strftime to unix-ms so the predicate works against the
    // unix-ms cloud_synced_at column. SQLite returns NULL for invalid dates,
    // which trips the IS NULL branch correctly.
    return this.db.prepare(`
      SELECT * FROM spaces
       WHERE deleted_at IS NULL
         AND (cloud_synced_at IS NULL
              OR (CAST(strftime('%s', updated_at) AS INTEGER) * 1000) > cloud_synced_at)
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

e) Replace the existing `delete` method to keep hard-delete behaviour (unchanged from current — used only by failed-promotion cleanup in space-service):

The existing `delete` already does cascading hard-delete via space_paths + spaces. Leave it as-is. Soft-delete is a separate path used by `space-service.deleteSpace`.

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd server && npm test -- space-store-sync.test.ts
```

Expected: PASS, all 11 tests.

- [ ] **Step 5: Run full server test suite to confirm no regressions**

```bash
cd server && npm test
```

Expected: PASS. (Existing tests don't touch `deleted_at`, so the filter clauses are a no-op for them.)

- [ ] **Step 6: Commit**

```bash
git add server/src/space-store.ts server/test/space-store-sync.test.ts
git commit -m "feat(spaces-sync): SpaceStore soft-delete + dirty-row + markSynced helpers"
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

describe("createSpaceSyncService — reconcile()", () => {
  let db: Database.Database;
  let store: SqliteSpaceStore;

  beforeEach(() => {
    db = makeDb();
    store = new SqliteSpaceStore(db);
    vi.restoreAllMocks();
  });

  it("returns zeros when no signed-in user", async () => {
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

  it("pulls cloud rows that don't exist locally and inserts them", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
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
      // No PUTs expected (no local dirty rows).
      throw new Error("unexpected fetch: " + url);
    });

    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => ({ id: "u1", email: "a@a", tier: "pro" }),
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

  it("updates a local row when cloud.updated_at > local.updated_at", async () => {
    insertRow(store, "work", { displayName: "Old Name" });
    // Mark synced at an old timestamp; we'll pretend cloud has a newer one.
    store.markSynced("work", 1000);
    // Bump local updated_at to be older than cloud's.
    db.prepare("UPDATE spaces SET updated_at = '1970-01-01 00:00:01' WHERE id = 'work'").run();

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
      currentUser: () => ({ id: "u1", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await svc.reconcile();
    const row = store.getById("work")!;
    expect(row.display_name).toBe("New Name");
    expect((row as { cloud_synced_at: number | null }).cloud_synced_at).toBe(9999);
  });

  it("soft-deletes a local row when cloud row carries deleted_at", async () => {
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
      currentUser: () => ({ id: "u1", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await svc.reconcile();
    expect(result.tombstoned).toBe(1);
    expect(store.getById("work")).toBeUndefined(); // filter excludes deleted
    const raw = db.prepare("SELECT deleted_at FROM spaces WHERE id = 'work'")
      .get() as { deleted_at: number };
    expect(raw.deleted_at).toBe(9000);
  });

  it("pushes dirty rows to PUT /api/spaces/:id and updates cloud_synced_at", async () => {
    insertRow(store, "work", { displayName: "Work" }); // dirty: cloud_synced_at is NULL

    const puts: Array<{ url: string; body: unknown }> = [];
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
            updated_at: 7777, deleted_at: null, created_at: 7777,
          },
        }), { status: 200 });
      }
      throw new Error("unexpected fetch: " + url);
    });

    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => ({ id: "u1", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await svc.reconcile();
    expect(result.pushed).toBe(1);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toMatchObject({ display_name: "Work" });

    const row = store.getById("work")!;
    expect((row as { cloud_synced_at: number | null }).cloud_synced_at).toBe(7777);
  });

  it("is idempotent — back-to-back reconciles with no mutations report 0/0/0", async () => {
    insertRow(store, "work");
    store.markSynced("work", 5000);
    db.prepare("UPDATE spaces SET updated_at = '1970-01-01 00:00:01' WHERE id = 'work'").run();

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ spaces: [] }), { status: 200 }));

    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => ({ id: "u1", email: "a@a", tier: "pro" }),
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

- [ ] **Step 3: Implement createSpaceSyncService — reconcile() only**

Create `server/src/space-sync-service.ts`:

```ts
// space-sync-service.ts — cross-device sync of the local spaces table.
// Spec: docs/superpowers/specs/2026-05-06-spaces-sync-spinout-design.md
//
// Wedge of #319 (R1). Pattern: dirty-row push + full pull on reconcile,
// fire-and-forget pushOne after each mutation.
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
  /** Pull cloud → local, then push local → cloud. Idempotent. Called on
   *  sign-in (BEFORE backfillPublications, so the headline _cloud-fallback
   *  fix is immediate) and on app start when signed in. */
  reconcile(): Promise<{ pulled: number; pushed: number; tombstoned: number }>;

  /** Fire-and-forget push for one row after a local mutation. Swallows
   *  network errors with a console.warn; the next reconcile() will retry. */
  pushOne(spaceId: string): Promise<void>;

  /** Fire-and-forget DELETE for a space the local server just soft-deleted.
   *  Symmetrical to pushOne. Swallows 404 (already gone) and network errors. */
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

// Compare local SpaceRow.updated_at (text, sqlite datetime('now') format)
// against cloud updated_at (unix ms). Returns local as unix ms.
function localUpdatedAtMs(row: SpaceRow): number {
  // SpaceRow.updated_at is a sqlite datetime string like "2026-05-06 12:34:56"
  // (UTC). new Date(...) on that string is UTC-parsed by Node — verified by
  // the surrounding store. Returns 0 (-> always-stale) if unparseable.
  const t = Date.parse(row.updated_at + "Z");
  return Number.isFinite(t) ? t : 0;
}

export function createSpaceSyncService(deps: SpaceSyncDeps): SpaceSyncService {
  return {
    async reconcile() {
      const user = deps.currentUser();
      const token = deps.sessionToken();
      if (!user || !token) return { pulled: 0, pushed: 0, tombstoned: 0 };

      // ── Pull ──
      let res: Response;
      try {
        res = await deps.fetch(`${deps.workerBase}/api/spaces/mine`, {
          headers: { Cookie: `oyster_session=${token}` },
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
      // Use raw SQL for the upsert path because store.update() filters by
      // UPDATABLE_COLUMNS and would refuse to set cloud_synced_at via the
      // public method (we set it directly via markSynced afterwards).
      const upsertStmt = deps.db.prepare(`
        INSERT INTO spaces
          (id, display_name, color, parent_id, summary_title, summary_content,
           scan_status, cloud_synced_at, updated_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'none', ?, datetime('now'), datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          color = excluded.color,
          parent_id = excluded.parent_id,
          summary_title = excluded.summary_title,
          summary_content = excluded.summary_content,
          cloud_synced_at = excluded.cloud_synced_at,
          updated_at = datetime('now')
      `);

      for (const cloud of cloudRows) {
        if (cloud.deleted_at !== null) {
          // Tombstone: soft-delete locally if not already.
          const existing = deps.db.prepare(
            "SELECT id, deleted_at FROM spaces WHERE id = ?",
          ).get(cloud.space_id) as { id: string; deleted_at: number | null } | undefined;
          if (existing && existing.deleted_at === null) {
            deps.store.softDelete(cloud.space_id);
            tombstoned++;
          }
          continue;
        }

        const existing = deps.db.prepare(
          "SELECT updated_at, cloud_synced_at FROM spaces WHERE id = ? AND deleted_at IS NULL",
        ).get(cloud.space_id) as { updated_at: string; cloud_synced_at: number | null } | undefined;

        if (!existing) {
          upsertStmt.run(
            cloud.space_id, cloud.display_name, cloud.color, cloud.parent_id,
            cloud.summary_title, cloud.summary_content, cloud.updated_at,
          );
          pulled++;
        } else {
          const localMs = Date.parse(existing.updated_at + "Z");
          const localComparable = Number.isFinite(localMs) ? localMs : 0;
          if (cloud.updated_at > localComparable) {
            upsertStmt.run(
              cloud.space_id, cloud.display_name, cloud.color, cloud.parent_id,
              cloud.summary_title, cloud.summary_content, cloud.updated_at,
            );
            pulled++;
          }
          // else: local is newer or equal; will be pushed below if dirty.
        }
      }

      // ── Push ──
      const dirty = deps.store.getDirtyRows();
      let pushed = 0;
      for (const row of dirty) {
        const ok = await pushRow(deps, row);
        if (ok) pushed++;
      }

      return { pulled, pushed, tombstoned };
    },

    async pushOne(spaceId) {
      const user = deps.currentUser();
      const token = deps.sessionToken();
      if (!user || !token) return;
      // Read by id including deleted? No — pushOne handles live mutations only.
      // Soft-deletes are pushed via the DELETE endpoint, separate path.
      const row = deps.db.prepare(
        "SELECT * FROM spaces WHERE id = ? AND deleted_at IS NULL",
      ).get(spaceId) as SpaceRow | undefined;
      if (!row) return;
      // Skip if the row is already clean — saves a redundant PUT.
      const localMs = localUpdatedAtMs(row);
      const synced = (row as { cloud_synced_at: number | null }).cloud_synced_at;
      if (synced !== null && synced >= localMs) return;
      await pushRow(deps, row);
    },

    async pushDelete(spaceId) {
      const user = deps.currentUser();
      const token = deps.sessionToken();
      if (!user || !token) return;
      try {
        const res = await deps.fetch(
          `${deps.workerBase}/api/spaces/${encodeURIComponent(spaceId)}`,
          { method: "DELETE", headers: { Cookie: `oyster_session=${token}` } },
        );
        // 404 = already gone elsewhere; swallow quietly. Other non-OK gets a warn.
        if (!res.ok && res.status !== 404) {
          console.warn(`[spaces] delete ${spaceId} non-ok ${res.status}`);
        }
      } catch (err) {
        console.warn(`[spaces] delete ${spaceId} failed:`, err);
      }
    },
  };
}

async function pushRow(deps: SpaceSyncDeps, row: SpaceRow): Promise<boolean> {
  const token = deps.sessionToken();
  if (!token) return false;
  const localMs = localUpdatedAtMs(row);
  let res: Response;
  try {
    res = await deps.fetch(`${deps.workerBase}/api/spaces/${encodeURIComponent(row.id)}`, {
      method: "PUT",
      headers: {
        Cookie: `oyster_session=${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        display_name: row.display_name,
        color: row.color,
        parent_id: row.parent_id,
        summary_title: row.summary_title,
        summary_content: row.summary_content,
        // Use the local row's updated_at translated to unix ms — the worker
        // uses this as the LWW comparison key.
        updated_at: localMs,
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
  const cloudUpdated = body?.space?.updated_at ?? localMs;
  deps.store.markSynced(row.id, cloudUpdated);
  return true;
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd server && npm test -- space-sync-service.test.ts
```

Expected: PASS, all 6 reconcile tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/space-sync-service.ts server/test/space-sync-service.test.ts
git commit -m "feat(spaces-sync): SpaceSyncService.reconcile() + pushOne() — pull/push/LWW"
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

  it("does nothing when row is missing", async () => {
    const fetchMock = vi.fn();
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => ({ id: "u1", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushOne("ghost");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when row is already clean (cloud_synced_at >= updated_at)", async () => {
    insertRow(store, "work");
    // Mark synced way in the future — dirtiness check returns false.
    store.markSynced("work", Date.now() + 60_000);

    const fetchMock = vi.fn();
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => ({ id: "u1", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushOne("work");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PUTs a dirty row and updates cloud_synced_at on 200", async () => {
    insertRow(store, "work");
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      return new Response(JSON.stringify({
        space: {
          owner_id: "u1", space_id: "work", display_name: "work",
          color: null, parent_id: null,
          summary_title: null, summary_content: null,
          updated_at: 8888, deleted_at: null, created_at: 8888,
        },
      }), { status: 200 });
    });
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => ({ id: "u1", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushOne("work");
    expect(fetchMock).toHaveBeenCalledOnce();
    const row = store.getById("work")!;
    expect((row as { cloud_synced_at: number | null }).cloud_synced_at).toBe(8888);
  });

  it("on 410, soft-deletes the local row (deletion wins over stale rename)", async () => {
    insertRow(store, "work");
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: "space_tombstoned" }), { status: 410 },
    ));
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => ({ id: "u1", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushOne("work");
    expect(store.getById("work")).toBeUndefined();
  });

  it("swallows network errors (console.warn, no throw)", async () => {
    insertRow(store, "work");
    const fetchMock = vi.fn(async () => { throw new Error("offline"); });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => ({ id: "u1", email: "a@a", tier: "pro" }),
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

Expected: PASS, all 12 tests (6 reconcile + 6 pushOne).

If any test fails, fix in `space-sync-service.ts` and re-run.

- [ ] **Step 3: Commit**

```bash
git add server/test/space-sync-service.test.ts
git commit -m "test(spaces-sync): pushOne() — auth, dirty check, 410 tombstone, network error"
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

c) Add fire-and-forget push at the end of every mutation method. After each `this.spaceStore.update(...)` / `insert(...)` / soft-delete, append:

In `createSpace` (after `this.spaceStore.insert(...)`, before the `return`):

```ts
    void this.spaceSync?.pushOne(id);
```

In `setSummary`, after `this.spaceStore.update(id, ...)`:

```ts
    void this.spaceSync?.pushOne(id);
```

In `updateSpace`, after `this.spaceStore.update(id, dbFields)`:

```ts
    void this.spaceSync?.pushOne(id);
```

In `deleteSpace`, replace the existing `this.spaceStore.delete(id)` (the very last line of the method) with the soft-delete + cloud push pattern:

```ts
    // Soft-delete locally; cloud propagates the tombstone via pushDelete.
    // (pushDelete is fire-and-forget; the next reconcile catches retries.)
    this.spaceStore.softDelete(id);
    void this.spaceSync?.pushDelete(id);
```

> **WHY soft-delete instead of hard-delete here?** Hard-delete loses the row entirely, which means the cloud DELETE isn't retried on offline → online. Soft-delete keeps the local row marked tombstoned (filtered out of getAll/getById, same effect on the surface) and lets pushDelete (or a later reconcile) propagate without re-discovering the deletion.

> **Known limit (acceptable for the wedge):** `scanSpace` updates `scan_status` etc. via `spaceStore.update()`, which bumps `updated_at`. The dirty-row predicate then fires for that row even though no synced field changed, so the next `reconcile()` pushes a no-op PUT. The worker accepts the write (LWW), bumps cloud `updated_at`, and peer devices re-pull — wasteful but not wrong. Acceptable for v1. Follow-up: split scan-status writes into a method that doesn't touch `updated_at`, or filter the dirty predicate by a `synced_dirty_at` column distinct from `updated_at`.

- [ ] **Step 2: Add pushDelete tests to space-sync-service.test.ts**

Append to the `pushOne()` describe block, then a sibling `describe("pushDelete()")`:

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

  it("DELETEs the cloud row when signed in", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe("DELETE");
      expect(url).toMatch(/\/api\/spaces\/work$/);
      return new Response(JSON.stringify({ space_id: "work", deleted_at: 1, updated_at: 1 }), { status: 200 });
    });
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => ({ id: "u1", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.pushDelete("work");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("swallows 404 (row gone elsewhere) without warning loudly", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "space_not_found" }), { status: 404 }));
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => ({ id: "u1", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(svc.pushDelete("work")).resolves.toBeUndefined();
  });

  it("swallows network errors (no throw)", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("offline"); });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const svc = createSpaceSyncService({
      db, store,
      currentUser: () => ({ id: "u1", email: "a@a", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://oyster.to",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(svc.pushDelete("work")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run server tests**

```bash
cd server && npm test
```

Expected: PASS — sync service has 16 tests now; space-store-sync stays green; existing tests untouched.

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
