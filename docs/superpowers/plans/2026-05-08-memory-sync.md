# Memory Sync Implementation Plan (#318)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cross-device sync for the Oyster memory store. A memory created on one Pro device must propagate to all other Pro devices owned by the same user, with deterministic precedence on forget and purge.

**Architecture:** Append-only event log (`memory_events`) paired with a redactable content store (`memory_payloads`), both mirrored on Cloudflare D1. The local SQLite `memories` table remains the FTS5 recall surface, materialised from events + payloads using the precedence rule **purged > forgotten > created**. No row sync, no LWW, no vector clocks, no merge function. Outbox flush is fire-and-forget per event after each `remember`/`forget`/`purge`; reconcile (full pull) runs on auth-changed and at app start. Pro-only.

**Tech Stack:** TypeScript, better-sqlite3 (local), Cloudflare D1 + Workers (cloud), vitest, @cloudflare/vitest-pool-workers.

**Spec:** `docs/superpowers/specs/2026-05-08-memory-sync-design.md`

**Worktree:** Per `feedback_worktree_location.md`, isolate this feature in `~/Dev/oyster-os.worktrees/memory-sync/`. Branch from `main` as `feat/memory-sync-318`.

**Pattern reference:** `server/src/space-sync-service.ts` and `infra/oyster-publish/src/worker.ts` lines 334–492 are the closest cousin. Memory sync mirrors the auth wiring and Pro-gate machinery but replaces LWW row sync with idempotent event ingestion and precedence-based materialisation.

## Shipping discipline: two PRs

This plan ships in **two PRs** for blast-radius reasons. Do not bundle.

- **PR 1 — local event model (Tasks 1–4).** Lands `memory_events` + `memory_payloads`, the event write API, the legacy backfill. **No cloud writes.** The MCP surface (`remember`/`forget`) is unchanged from the user's perspective; everything still works offline. Mergeable on its own.
- **PR 2 — cloud sync (Tasks 4.4, 4.5, 5–10).** Begins with the **profile owner binding prerequisite** (Task 4.4) — without it, cross-device pull would garble the local SQLite when a second Pro account signs in. Then bootstraps the new `oyster-cloud` Worker (Task 4.5), adds the D1 schema and Worker routes, the `MemorySyncService`, and the auth/startup wiring. Depends on PR 1 being merged.
- **Verification + ship (Tasks 11–12)** lands in PR 2.

If anything in PR 1 is rolled back, the user-visible behaviour is unchanged. If PR 2 is rolled back, memory sync stops syncing but local memories remain intact.

**Hard rule:** Task 4.4 must land before any other PR-2 task is merged. The profile owner guard is load-bearing for the safety of every other cloud sync service (memory now, sessions later, spaces retroactively).

## Worker boundary: `oyster-cloud`

Memory sync routes go in a **new** `infra/oyster-cloud/` Worker, not in `infra/oyster-publish/`. The boundary:

- `auth-worker` — identity, sessions, OAuth, account lifecycle.
- `oyster-publish` — public viewer, share tokens, published artefact access.
- `oyster-cloud` — signed-in private user APIs: `/api/memories/*`, future `/api/sessions/*`, future `/api/spaces/*` (migration tracked as a follow-up).

The new Worker shares the `oyster-auth` D1 binding (same database, same migrations directory) so it can resolve sessions via the same mechanism `oyster-publish` uses. Spaces sync stays in `oyster-publish` for now — migrating those routes is explicitly a **follow-up**, not part of this plan, to keep blast radius bounded. The follow-up issue: "Migrate /api/spaces/* from oyster-publish to oyster-cloud."

## Account-switching policy (v1)

A local Oyster instance is treated as **single-Pro-account** for memory sync. Memories created while signed out, signed into a free account, or signed into a different Pro account stay local-only — they will not sync to your current Pro account.

The policy has two enforcement layers:

1. **Profile owner binding (Task 4.4).** First Pro sign-in claims the local Oyster profile (`profile_binding.cloud_owner_id`). All cloud sync services check `currentUser.id === profile_owner_id` before pulling or pushing. A different Pro user signing into the same local profile is **blocked** from sync entirely — no pull, no push — and surfaces an error to the UI: *"This Oyster profile belongs to another account. Use a different local profile or reset this one."* This prevents the local SQLite from being garbled with a second user's cloud events on pull.
2. **Per-event ownership tagging (Task 1).** Every event row carries `cloud_owner_id` set at write time from the current auth state. `pushPending` filters strictly on `cloud_owner_id = currentUser.id`. Pre-existing legacy memories backfilled at boot are tagged NULL and never push.

The two layers are complementary: layer 1 stops User B's data flowing into User A's profile via pull; layer 2 stops User A's local-only data flowing into User B's cloud account via push. Both are necessary.

**Scope statement:** Only memories created while signed into the bound Pro profile sync. Memories created while signed out, on a free account, before binding, or under a different Pro account stay local-only. This is a deliberate v1 simplification; a future plan can add an explicit "claim local memories for this Pro account" flow.

---

## Task 1: Local schema migration — events + payloads + recall surface

**Goal:** Add the two new tables (`memory_events`, `memory_payloads`) and one column on `memories` (`purged_at`). Migrations are additive `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN` with try/catch for idempotency, matching the existing convention in `memory-store.ts`.

**Files:**
- Modify: `server/src/memory-store.ts:117-191` (the `init()` method that runs DDL)
- Modify: `server/test/memory-store.test.ts` (new test cases at the bottom)

- [ ] **Step 1: Write failing test for new tables**

In `server/test/memory-store.test.ts` (append):

```typescript
describe("schema migration — memory_events + memory_payloads", () => {
  it("creates memory_events with the expected columns", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mem-events-"));
    const provider = new SqliteFtsMemoryProvider(tmp);
    await provider.init();
    const db = new Database(join(tmp, "memory.db"));
    const cols = db.prepare("PRAGMA table_info(memory_events)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      "cloud_owner_id", "cloud_synced_at", "created_at",
      "event_id", "event_type", "memory_id", "space_id",
    ]);
    db.close();
    provider.close();
  });

  it("enforces event_type CHECK constraint", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mem-check-"));
    const provider = new SqliteFtsMemoryProvider(tmp);
    await provider.init();
    const db = new Database(join(tmp, "memory.db"));
    expect(() => db.prepare(
      `INSERT INTO memory_events (event_id, memory_id, event_type, created_at)
       VALUES ('ev-bad', 'm', 'bogus', 0)`,
    ).run()).toThrow(/CHECK constraint failed/);
    db.close();
    provider.close();
  });

  it("creates memory_payloads with the expected columns", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mem-payloads-"));
    const provider = new SqliteFtsMemoryProvider(tmp);
    await provider.init();
    const db = new Database(join(tmp, "memory.db"));
    const cols = db.prepare("PRAGMA table_info(memory_payloads)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(["content", "memory_id", "purged_at", "tags"]);
    db.close();
    provider.close();
  });

  it("adds purged_at to memories", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mem-purgedat-"));
    const provider = new SqliteFtsMemoryProvider(tmp);
    await provider.init();
    const db = new Database(join(tmp, "memory.db"));
    const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "purged_at")).toBe(true);
    db.close();
    provider.close();
  });

  it("re-running init() is idempotent", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mem-idem-"));
    const provider1 = new SqliteFtsMemoryProvider(tmp);
    await provider1.init();
    provider1.close();
    const provider2 = new SqliteFtsMemoryProvider(tmp);
    await expect(provider2.init()).resolves.not.toThrow();
    provider2.close();
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `cd server && npx vitest run test/memory-store.test.ts -t "schema migration"`
Expected: 4 failures — tables/columns don't exist yet.

- [ ] **Step 3: Add the schema in `init()`**

In `server/src/memory-store.ts`, after the existing `memory_recalls` block (around line 165), insert:

```typescript
    // ── #318 cloud sync substrate ─────────────────────────────────
    // Append-only event log. Doubles as outbox via cloud_synced_at IS NULL.
    // Per-type uniqueness mirrors the cloud constraints (spec Q6) so backfill
    // and replay are safely idempotent locally too.
    // cloud_owner_id is captured at write time from auth state; events are
    // only pushed when cloud_owner_id matches the current Pro user. This is
    // the single-Pro-account-per-device guard (see "Account-switching policy").
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_events (
        event_id        TEXT    PRIMARY KEY,
        memory_id       TEXT    NOT NULL,
        event_type      TEXT    NOT NULL CHECK (event_type IN ('memory_created','memory_forgotten','memory_purged')),
        space_id        TEXT,
        cloud_owner_id  TEXT,
        created_at      INTEGER NOT NULL,
        cloud_synced_at INTEGER
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_events_memory ON memory_events(memory_id)`);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memory_events_pending
         ON memory_events(cloud_synced_at) WHERE cloud_synced_at IS NULL`,
    );
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_memory_events_created
         ON memory_events(memory_id) WHERE event_type = 'memory_created'`,
    );
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_memory_events_forgotten
         ON memory_events(memory_id) WHERE event_type = 'memory_forgotten'`,
    );
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_memory_events_purged
         ON memory_events(memory_id) WHERE event_type = 'memory_purged'`,
    );

    // Redactable content store. Purge nulls content + tags and sets purged_at.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_payloads (
        memory_id  TEXT PRIMARY KEY,
        content    TEXT,
        tags       TEXT NOT NULL DEFAULT '[]',
        purged_at  INTEGER
      )
    `);

    // Add purged_at to memories. Recall code filters this column out so
    // forgotten and purged rows behave identically for FTS5 readers.
    try {
      this.db.exec(`ALTER TABLE memories ADD COLUMN purged_at INTEGER`);
    } catch (err) {
      if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/memory-store.test.ts -t "schema migration"`
Expected: 4 passing.

- [ ] **Step 5: Run the full memory-store suite to confirm no regressions**

Run: `cd server && npx vitest run test/memory-store.test.ts`
Expected: all existing tests still pass; 4 new tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/memory-store.ts server/test/memory-store.test.ts
git commit -m "feat(memory): add memory_events + memory_payloads tables (#318)"
```

---

## Task 2: Event write API + materialisation function

**Goal:** Add internal methods that write to the event log, payload store, and the materialised `memories` table consistently. Recall queries continue to read `memories` (FTS5 unchanged).

**Files:**
- Modify: `server/src/memory-store.ts` (new methods on `SqliteFtsMemoryProvider`)
- Modify: `server/test/memory-store.test.ts`

The contract:

```typescript
// New on the provider:
writeCreated(input: {
  memory_id?: string;
  content: string;
  space_id?: string | null;
  tags?: string[];
  source_session_id?: string | null;
  created_at?: number;
  cloud_owner_id?: string | null;
}): { memory_id: string; event_id: string; inserted: boolean };
// inserted=false means a memory_created event already existed for this
// memory_id (per-type uniqueness rejected the new write); event_id is the
// EXISTING event's id. Caller can treat this as a no-op.

writeForgotten(memory_id: string): boolean;
// true if a new forget event was written; false if one already existed
// (idempotent — per-type uniqueness rejects duplicates).

writePurged(memory_id: string): boolean;
// true if a new purge event was written, even when no create event exists
// yet (purge-before-create is a valid sequence). false only if a purge
// already exists for this memory_id (idempotent).

materialiseMemory(memory_id: string): void;
// (re)derive the memories recall surface for this memory_id from events +
// payloads using precedence purged > forgotten > created.
```

- [ ] **Step 1: Write failing tests for `writeCreated`**

Append to `server/test/memory-store.test.ts`:

```typescript
describe("event write API — writeCreated", () => {
  it("inserts an event, payload, and materialised memories row", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ev-created-"));
    const provider = new SqliteFtsMemoryProvider(tmp);
    await provider.init();
    const result = provider.writeCreated({ content: "hello world", tags: ["greeting"] });
    expect(result.memory_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.event_id).toMatch(/^[0-9a-f-]{36}$/);

    const memories = await provider.list();
    expect(memories).toHaveLength(1);
    expect(memories[0].content).toBe("hello world");
    expect(memories[0].tags).toEqual(["greeting"]);

    const recalled = await provider.recall({ query: "hello" });
    expect(recalled).toHaveLength(1);
    expect(recalled[0].id).toBe(result.memory_id);
    provider.close();
  });

  it("a fresh writeCreated event is pending sync (cloud_synced_at IS NULL)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ev-pending-"));
    const provider = new SqliteFtsMemoryProvider(tmp);
    await provider.init();
    const { event_id } = provider.writeCreated({ content: "pending" });
    const db = new Database(join(tmp, "memory.db"));
    const row = db.prepare("SELECT cloud_synced_at FROM memory_events WHERE event_id = ?").get(event_id) as { cloud_synced_at: number | null };
    expect(row.cloud_synced_at).toBeNull();
    db.close();
    provider.close();
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `cd server && npx vitest run test/memory-store.test.ts -t "writeCreated"`
Expected: 2 failures — `provider.writeCreated` is not a function.

- [ ] **Step 3: Implement `writeCreated`**

In `server/src/memory-store.ts`, add to the `SqliteFtsMemoryProvider` class. Place after `findExact` and before `remember`:

```typescript
  writeCreated(input: {
    memory_id?: string;
    content: string;
    space_id?: string | null;
    tags?: string[];
    source_session_id?: string | null;
    created_at?: number;
    cloud_owner_id?: string | null;
  }): { memory_id: string; event_id: string; inserted: boolean } {
    const memory_id = input.memory_id ?? crypto.randomUUID();
    const event_id  = crypto.randomUUID();
    const space_id  = input.space_id ?? null;
    const tags      = JSON.stringify(input.tags ?? []);
    const ssid      = input.source_session_id ?? null;
    const created_at = input.created_at ?? Date.now();
    const owner_id  = input.cloud_owner_id ?? null;

    let inserted = false;
    let returned_event_id = event_id;

    const txn = this.db.transaction(() => {
      const info = this.db.prepare(
        `INSERT OR IGNORE INTO memory_events
           (event_id, memory_id, event_type, space_id, cloud_owner_id, created_at, cloud_synced_at)
         VALUES (?, ?, 'memory_created', ?, ?, ?, NULL)`,
      ).run(event_id, memory_id, space_id, owner_id, created_at);
      inserted = info.changes > 0;

      if (!inserted) {
        // A memory_created event already exists for this memory_id. Look up
        // its event_id so the caller can reference the canonical event.
        const existing = this.db.prepare(
          `SELECT event_id FROM memory_events WHERE memory_id = ? AND event_type = 'memory_created'`,
        ).get(memory_id) as { event_id: string } | undefined;
        if (existing) returned_event_id = existing.event_id;
      }

      this.db.prepare(
        `INSERT OR IGNORE INTO memory_payloads (memory_id, content, tags)
         VALUES (?, ?, ?)`,
      ).run(memory_id, input.content, tags);

      this.materialiseMemory(memory_id, { ssid });
    });
    txn();
    return { memory_id, event_id: returned_event_id, inserted };
  }
```

(Stub `materialiseMemory` with a TODO body that does nothing — Step 5 fills it in. The created-only path needs only an INSERT into `memories`; we'll add that here for the test to pass, then Step 5 generalises.)

For now, in `materialiseMemory(memory_id, opts?)` (also new method on the class):

```typescript
  materialiseMemory(memory_id: string, opts?: { ssid?: string | null }): void {
    // Pick highest-precedence event for this memory_id.
    type EvRow = { event_type: string; space_id: string | null; created_at: number };
    const events = this.db.prepare(
      `SELECT event_type, space_id, created_at FROM memory_events WHERE memory_id = ?`,
    ).all(memory_id) as EvRow[];
    if (events.length === 0) {
      this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(memory_id);
      return;
    }
    const has = (t: string) => events.some((e) => e.event_type === t);
    const created = events.find((e) => e.event_type === "memory_created");

    if (has("memory_purged")) {
      // Purge: nullify payload + remove from recall surface.
      this.db.prepare(
        `UPDATE memory_payloads SET content = NULL, tags = '[]', purged_at = ? WHERE memory_id = ?`,
      ).run(Date.now(), memory_id);
      this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(memory_id);
      return;
    }

    if (!created) {
      // Forget arrived before create. Nothing to materialise yet.
      return;
    }

    const payload = this.db.prepare(
      `SELECT content, tags FROM memory_payloads WHERE memory_id = ?`,
    ).get(memory_id) as { content: string | null; tags: string } | undefined;
    if (!payload || payload.content === null) {
      // Created event with no payload yet, or payload purged. Nothing to show.
      this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(memory_id);
      return;
    }

    const ssid = opts?.ssid ?? null;
    const supersededBy = has("memory_forgotten") ? "forgotten" : null;

    // Upsert the recall surface. FTS5 triggers on memories keep the index in sync.
    this.db.prepare(
      `INSERT INTO memories (id, space_id, content, tags, source_session_id, superseded_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime(?, 'unixepoch'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         space_id = excluded.space_id,
         content = excluded.content,
         tags = excluded.tags,
         superseded_by = excluded.superseded_by,
         updated_at = datetime('now')`,
    ).run(
      memory_id,
      created.space_id,
      payload.content,
      payload.tags,
      ssid,
      supersededBy,
      Math.floor(created.created_at / 1000),
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/memory-store.test.ts -t "writeCreated"`
Expected: 2 passing.

- [ ] **Step 5: Write failing tests for `writeForgotten` and `writePurged` precedence**

Append to `server/test/memory-store.test.ts`:

```typescript
describe("event write API — writeForgotten / writePurged / precedence", () => {
  async function fresh() {
    const tmp = mkdtempSync(join(tmpdir(), "ev-prec-"));
    const provider = new SqliteFtsMemoryProvider(tmp);
    await provider.init();
    return provider;
  }

  it("forget hides the memory from recall but content remains in payload", async () => {
    const provider = await fresh();
    const { memory_id } = provider.writeCreated({ content: "secret" });
    expect(provider.writeForgotten(memory_id)).toBe(true);
    const found = await provider.recall({ query: "secret" });
    expect(found).toHaveLength(0);
    const list = await provider.list();
    expect(list).toHaveLength(0);
    provider.close();
  });

  it("purge nulls payload content and removes from recall", async () => {
    const provider = await fresh();
    const { memory_id } = provider.writeCreated({ content: "AKIA-secret-key" });
    expect(provider.writePurged(memory_id)).toBe(true);
    const found = await provider.recall({ query: "AKIA" });
    expect(found).toHaveLength(0);
    const list = await provider.list();
    expect(list).toHaveLength(0);
    provider.close();
  });

  it("late create after purge does not restore content", async () => {
    const provider = await fresh();
    const memory_id = "11111111-1111-1111-1111-111111111111";
    // Simulate purge-arrives-before-create by writing the purge event first.
    provider.writePurged(memory_id);
    // Now writeCreated for the same id.
    provider.writeCreated({ memory_id, content: "should-not-appear" });
    const list = await provider.list();
    expect(list).toHaveLength(0);
    const found = await provider.recall({ query: "should-not-appear" });
    expect(found).toHaveLength(0);
    provider.close();
  });

  it("forget after create then forget again is a no-op", async () => {
    const provider = await fresh();
    const { memory_id } = provider.writeCreated({ content: "hi" });
    expect(provider.writeForgotten(memory_id)).toBe(true);
    expect(provider.writeForgotten(memory_id)).toBe(false); // idempotent: returns false on no-op
    provider.close();
  });
});
```

- [ ] **Step 6: Run failing tests**

Run: `cd server && npx vitest run test/memory-store.test.ts -t "writeForgotten"`
Expected: failures — methods don't exist.

- [ ] **Step 7: Implement `writeForgotten` and `writePurged`**

In the same class, after `writeCreated`:

```typescript
  writeForgotten(memory_id: string, cloud_owner_id: string | null = null): boolean {
    // Idempotent: per-type uniqueness means a second forget event is rejected.
    const info = this.db.prepare(
      `INSERT OR IGNORE INTO memory_events
         (event_id, memory_id, event_type, space_id, cloud_owner_id, created_at, cloud_synced_at)
       VALUES (?, ?, 'memory_forgotten', NULL, ?, ?, NULL)`,
    ).run(crypto.randomUUID(), memory_id, cloud_owner_id, Date.now());
    if (info.changes === 0) return false;
    this.materialiseMemory(memory_id);
    return true;
  }

  writePurged(memory_id: string, cloud_owner_id: string | null = null): boolean {
    // Succeeds even when no memory_created event exists yet (purge-before-create
    // is a valid sequence — purge dominates regardless of arrival order).
    // Returns false only when a memory_purged event already exists for this
    // memory_id (idempotent).
    const info = this.db.prepare(
      `INSERT OR IGNORE INTO memory_events
         (event_id, memory_id, event_type, space_id, cloud_owner_id, created_at, cloud_synced_at)
       VALUES (?, ?, 'memory_purged', NULL, ?, ?, NULL)`,
    ).run(crypto.randomUUID(), memory_id, cloud_owner_id, Date.now());
    if (info.changes === 0) return false;
    // Ensure a payload row exists so the materialisation pass can null its content.
    this.db.prepare(
      `INSERT OR IGNORE INTO memory_payloads (memory_id, content, tags) VALUES (?, NULL, '[]')`,
    ).run(memory_id);
    this.materialiseMemory(memory_id);
    return true;
  }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd server && npx vitest run test/memory-store.test.ts -t "writeForgotten"`
Expected: 4 passing.

- [ ] **Step 9: Run the full memory-store suite**

Run: `cd server && npx vitest run test/memory-store.test.ts`
Expected: all passing (existing + new).

- [ ] **Step 10: Commit**

```bash
git add server/src/memory-store.ts server/test/memory-store.test.ts
git commit -m "feat(memory): event write API with precedence-based materialisation (#318)"
```

---

## Task 3: Migrate `remember` / `forget` to write through events; add internal `purge`

**Goal:** Existing MCP/HTTP entry points (`remember`, `forget`) now go through the event API. Add a server-internal `purge(id)` method on the provider — not exposed via MCP yet (per spec: "Possibly not exposed via MCP at all in the first cut"). Each entry point captures `cloud_owner_id` from auth state at write time, per the account-switching policy stated at the top of this plan.

**Files:**
- Modify: `server/src/memory-store.ts` (extend `RememberInput`; add `resolveCurrentOwnerId` callback to `registerMemoryTools`; rewrite `remember`/`forget` bodies; add `purge` to interface + impl)
- Modify: `server/src/index.ts` (pass `resolveCurrentOwnerId` from auth state when calling `registerMemoryTools`)
- Modify: `server/src/routes/memories.ts` (HTTP DELETE forwards owner_id from auth state)
- Modify: `server/test/memory-store.test.ts`

- [ ] **Step 1: Extend `RememberInput`**

In the `RememberInput` interface at the top of `memory-store.ts`:

```typescript
export interface RememberInput {
  content: string;
  space_id?: string;
  tags?: string[];
  source_session_id?: string | null;
  cloud_owner_id?: string | null;
}
```

- [ ] **Step 2: Migrate `remember()` body**

Replace the `async remember(input)` method body in `SqliteFtsMemoryProvider`:

```typescript
  async remember(input: RememberInput): Promise<Memory> {
    const spaceId = input.space_id ?? null;

    // Conservative dedupe: exact content match in same scope. Preserves the
    // existing surface contract — `remember` returns the existing row instead
    // of duplicating. Skip for empty content (defensive).
    if (input.content.length > 0) {
      const existing = this.stmts.findExact.get(input.content, spaceId, spaceId) as MemoryRow | undefined;
      if (existing) return rowToMemory(existing);
    }

    const { memory_id } = this.writeCreated({
      content: input.content,
      space_id: spaceId,
      tags: input.tags,
      source_session_id: input.source_session_id,
      cloud_owner_id: input.cloud_owner_id ?? null,
    });
    const row = this.stmts.getById.get(memory_id) as MemoryRow;
    return rowToMemory(row);
  }
```

- [ ] **Step 3: Migrate `forget()` body**

Add an optional second parameter to the interface:

```typescript
forget(id: string, cloud_owner_id?: string | null): Promise<boolean>;
```

Replace the implementation:

```typescript
  async forget(id: string, cloud_owner_id: string | null = null): Promise<boolean> {
    const row = this.stmts.getById.get(id) as MemoryRow | undefined;
    if (!row) return false;
    this.writeForgotten(id, cloud_owner_id);
    return true;
  }
```

- [ ] **Step 4: Add `purge` to the `MemoryProvider` interface**

In the `MemoryProvider` interface (top of file), add:

```typescript
  /** Server-internal hard-redaction. Writes a purge event and nulls payload
   *  content. Not exposed via MCP in v1; reserved for "delete forever" UI,
   *  account deletion, and secret-exposure flows. */
  purge(id: string, cloud_owner_id?: string | null): Promise<boolean>;
```

- [ ] **Step 5: Implement `purge` on the provider**

After `forget`:

```typescript
  async purge(id: string, cloud_owner_id: string | null = null): Promise<boolean> {
    const row = this.stmts.getById.get(id) as MemoryRow | undefined;
    const hasEvent = this.db.prepare(
      `SELECT 1 FROM memory_events WHERE memory_id = ? LIMIT 1`,
    ).get(id);
    if (!row && !hasEvent) return false;
    this.writePurged(id, cloud_owner_id);
    return true;
  }
```

- [ ] **Step 6: Wire `resolveCurrentOwnerId` callback into `registerMemoryTools`**

Update the `registerMemoryTools` signature in `memory-store.ts` to accept a callback that returns the current Pro user's id (or null):

```typescript
export function registerMemoryTools(
  tool: ToolDefiner,
  provider: MemoryProvider,
  resolveActiveSessionId: () => string | null = () => null,
  resolveCurrentOwnerId: () => string | null = () => null,
): void {
```

Inside `remember`'s tool handler, pass `cloud_owner_id`:

```typescript
    async ({ content, space_id, tags }) => provider.remember({
      content,
      space_id,
      tags,
      source_session_id: resolveActiveSessionId(),
      cloud_owner_id: resolveCurrentOwnerId(),
    }),
```

Inside `forget`'s tool handler, pass owner:

```typescript
    async ({ id }) => {
      await provider.forget(id, resolveCurrentOwnerId());
      return `Memory "${id}" forgotten.`;
    },
```

Then in `server/src/index.ts`, where `registerMemoryTools` is invoked (find via the existing `resolveActiveSessionId` argument), add the new callback. **Returns the user id only for Pro accounts** — free users tag events as `null` so they never push and aren't candidates for sync claiming later:

```typescript
registerMemoryTools(
  tool,
  memoryProvider,
  resolveActiveSessionId,
  () => {
    const u = authService.getState().user;
    return u?.tier === "pro" ? u.id : null;
  },
);
```

Also update `server/src/routes/memories.ts`'s DELETE handler to pass the same Pro-gated id to `provider.forget(id, …)`:

```typescript
const u = authService.getState().user;
const ownerId = u?.tier === "pro" ? u.id : null;
await provider.forget(id, ownerId);
```

- [ ] **Step 7: Write a test for `purge`**

Append to `server/test/memory-store.test.ts`:

```typescript
describe("provider.purge", () => {
  it("purges existing memory and returns true", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "purge-"));
    const provider = new SqliteFtsMemoryProvider(tmp);
    await provider.init();
    const m = await provider.remember({ content: "secret-content" });
    expect(await provider.purge(m.id)).toBe(true);
    expect(await provider.recall({ query: "secret-content" })).toHaveLength(0);
    provider.close();
  });

  it("returns false when memory does not exist", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "purge-missing-"));
    const provider = new SqliteFtsMemoryProvider(tmp);
    await provider.init();
    expect(await provider.purge("nonexistent")).toBe(false);
    provider.close();
  });
});
```

- [ ] **Step 8: Run the full memory-store suite**

Run: `cd server && npx vitest run test/memory-store.test.ts`
Expected: all passing — existing `remember`/`forget` tests still pass because the surface contract is unchanged.

- [ ] **Step 9: Run the full server test suite to catch downstream breakage**

Run: `cd server && npx vitest run`
Expected: all passing. If `routes/memories.ts` or `mcp-server.ts` tests fail, debug — the surface should be unchanged.

- [ ] **Step 10: Commit**

```bash
git add server/src/memory-store.ts server/src/index.ts server/src/routes/memories.ts server/test/memory-store.test.ts
git commit -m "feat(memory): route remember/forget through event API; add internal purge (#318)"
```

---

## Task 4: Backfill existing memories at boot

**Goal:** On server start, any existing `memories` rows that have no corresponding `memory_created` event get one inserted (with the original `created_at`). If `superseded_by` is non-NULL, also insert a `memory_forgotten` event. Idempotent — re-running is a no-op due to the per-type unique indexes.

Backfilled events are tagged with `cloud_owner_id = NULL`. They become syncable when the user signs in to a Pro account AND a follow-up plan ships an explicit "claim local memories for this Pro account" flow. v1 keeps pre-existing memories local-only by default (privacy-first); a Pro user creating new memories after sign-in gets full sync.

**Files:**
- Modify: `server/src/memory-store.ts` (new method `backfillFromLegacy()` + call in `init()`)
- Modify: `server/test/memory-store.test.ts`

- [ ] **Step 1: Write failing test for backfill**

Append to `server/test/memory-store.test.ts`:

```typescript
describe("backfill from legacy memories rows", () => {
  it("creates memory_created events for pre-existing rows on init()", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bf-"));
    // First boot: write memories the old way (skip writeCreated path) by
    // simulating a legacy row directly in the DB.
    const provider1 = new SqliteFtsMemoryProvider(tmp);
    await provider1.init();
    const db1 = new Database(join(tmp, "memory.db"));
    db1.prepare(`DELETE FROM memory_events`).run();
    db1.prepare(`DELETE FROM memory_payloads`).run();
    db1.prepare(
      `INSERT INTO memories (id, content, tags, created_at, updated_at)
       VALUES ('legacy-1', 'old memory', '["legacy"]', '2026-01-01', '2026-01-01')`,
    ).run();
    db1.close();
    provider1.close();

    // Second boot: backfill should kick in.
    const provider2 = new SqliteFtsMemoryProvider(tmp);
    await provider2.init();
    const db2 = new Database(join(tmp, "memory.db"));
    const ev = db2.prepare(
      `SELECT event_type, cloud_synced_at FROM memory_events WHERE memory_id = ?`,
    ).get("legacy-1") as { event_type: string; cloud_synced_at: number | null } | undefined;
    expect(ev?.event_type).toBe("memory_created");
    expect(ev?.cloud_synced_at).toBeNull();
    const pay = db2.prepare(
      `SELECT content FROM memory_payloads WHERE memory_id = ?`,
    ).get("legacy-1") as { content: string } | undefined;
    expect(pay?.content).toBe("old memory");
    db2.close();
    provider2.close();
  });

  it("re-running init() is idempotent (no duplicate events)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bf-idem-"));
    const provider1 = new SqliteFtsMemoryProvider(tmp);
    await provider1.init();
    await provider1.remember({ content: "hello" });
    provider1.close();

    const provider2 = new SqliteFtsMemoryProvider(tmp);
    await provider2.init();
    const db = new Database(join(tmp, "memory.db"));
    const count = db.prepare(`SELECT COUNT(*) as c FROM memory_events`).get() as { c: number };
    expect(count.c).toBe(1); // one create event from the original remember(), not duplicated
    db.close();
    provider2.close();
  });

  it("emits memory_forgotten for legacy soft-deleted rows", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bf-forgotten-"));
    const provider1 = new SqliteFtsMemoryProvider(tmp);
    await provider1.init();
    const db1 = new Database(join(tmp, "memory.db"));
    db1.prepare(
      `INSERT INTO memories (id, content, tags, superseded_by, created_at, updated_at)
       VALUES ('legacy-2', 'gone', '[]', 'forgotten', '2026-01-01', '2026-01-01')`,
    ).run();
    db1.close();
    provider1.close();

    const provider2 = new SqliteFtsMemoryProvider(tmp);
    await provider2.init();
    const db2 = new Database(join(tmp, "memory.db"));
    const types = db2.prepare(
      `SELECT event_type FROM memory_events WHERE memory_id = ? ORDER BY created_at`,
    ).all("legacy-2") as Array<{ event_type: string }>;
    expect(types.map((r) => r.event_type)).toEqual(["memory_created", "memory_forgotten"]);
    db2.close();
    provider2.close();
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `cd server && npx vitest run test/memory-store.test.ts -t "backfill"`
Expected: 3 failures.

- [ ] **Step 3: Implement `backfillFromLegacy()`**

In `SqliteFtsMemoryProvider`, after `materialiseMemory`:

```typescript
  /** One-time backfill: for each row in `memories` without a matching
   *  memory_created event, write events + payload from the legacy state.
   *  Idempotent because the per-type uniqueness indexes reject duplicates. */
  private backfillFromLegacy(): void {
    type LegacyRow = {
      id: string; space_id: string | null; content: string; tags: string;
      superseded_by: string | null; created_at: string; source_session_id: string | null;
    };
    const rows = this.db.prepare(
      `SELECT m.id, m.space_id, m.content, m.tags, m.superseded_by, m.created_at, m.source_session_id
         FROM memories m
         LEFT JOIN memory_events e ON e.memory_id = m.id AND e.event_type = 'memory_created'
        WHERE e.memory_id IS NULL`,
    ).all() as LegacyRow[];

    for (const r of rows) {
      // SQLite text timestamps → unix ms
      const created_ms = Date.parse(r.created_at + "Z") || Date.now();
      // cloud_owner_id intentionally NULL — backfilled events do not push to
      // any current Pro account. Pre-existing memories stay local until an
      // explicit claim flow is shipped (see "Account-switching policy").
      this.db.prepare(
        `INSERT OR IGNORE INTO memory_events
           (event_id, memory_id, event_type, space_id, cloud_owner_id, created_at, cloud_synced_at)
         VALUES (?, ?, 'memory_created', ?, NULL, ?, NULL)`,
      ).run(crypto.randomUUID(), r.id, r.space_id, created_ms);

      this.db.prepare(
        `INSERT OR IGNORE INTO memory_payloads (memory_id, content, tags)
         VALUES (?, ?, ?)`,
      ).run(r.id, r.content, r.tags);

      if (r.superseded_by !== null) {
        // Map legacy 'forgotten' / 'purged' marker to the appropriate event.
        const evType = r.superseded_by === "purged" ? "memory_purged" : "memory_forgotten";
        this.db.prepare(
          `INSERT OR IGNORE INTO memory_events
             (event_id, memory_id, event_type, space_id, cloud_owner_id, created_at, cloud_synced_at)
           VALUES (?, ?, ?, NULL, NULL, ?, NULL)`,
        ).run(crypto.randomUUID(), r.id, evType, created_ms + 1);
      }
    }
  }
```

- [ ] **Step 4: Call backfill at end of `init()`**

In `init()`, after the prepared statements + transaction setup (just before the closing brace), add:

```typescript
    this.backfillFromLegacy();
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run test/memory-store.test.ts -t "backfill"`
Expected: 3 passing.

- [ ] **Step 6: Run the full server test suite**

Run: `cd server && npx vitest run`
Expected: all passing.

- [ ] **Step 7: Commit**

```bash
git add server/src/memory-store.ts server/test/memory-store.test.ts
git commit -m "feat(memory): backfill legacy memories into events at boot (#318)"
```

---

## Task 4.4: Profile owner binding (prerequisite for all cloud sync)

**Goal:** Bind the local Oyster profile to a single Pro account on first Pro sign-in. Block cloud sync for any other Pro user signing into the same local profile, so a second user's cloud events cannot pollute the first user's local SQLite via pull.

**Why this is load-bearing:** the per-event `cloud_owner_id` filter in Task 1 protects pushes — User B's events tagged with B's id won't push into a context where currentUser is A. But it does **not** protect pulls. Without a profile-level owner check, User B signing into User A's local Oyster profile would trigger a pull of B's cloud memories into A's local SQLite, garbling the local DB. The profile owner binding closes that hole.

**Scope:** This task is the prerequisite for **all** cloud sync — memory now and spaces (already shipped in PR #407). It updates `space-sync-service.ts` in the same task so the binding is enforced everywhere from day one. There is no "spaces follow-up" — the binding-gate-for-spaces lands here, in PR 2, alongside the memory work.

**Files:**
- Modify: `server/src/db.ts` (or wherever the main `oyster.db` schema is initialised) — add `profile_binding` migration
- Create: `server/src/profile-binding-service.ts`
- Create: `server/test/profile-binding-service.test.ts`
- Modify: `server/src/index.ts` — construct `profileBinding`; add `canRunCloudSync()` gate; pass `profileBinding` into both `createSpaceSyncService` and (later in Task 10) `createMemorySyncService`
- Modify: `server/src/space-sync-service.ts` — accept `profileBinding` dep; gate `reconcile`/`pushOne`/`pushDelete` on `profileBinding.isOwnedBy(currentUser.id)`
- Modify: `server/test/space-sync-service.test.ts` — construct a real `ProfileBindingService` in tests; add regression test for the conflict path

**Forward dependency:** Task 8 (`MemorySyncService`) consumes the `ProfileBindingService` exported here as a constructor dependency. Task 8's content already reflects this — it accepts `profileBinding` in `MemorySyncDeps` and gates `isProSession` on `isOwnedBy`. This task only creates the service and the auth wiring; it does not modify `memory-sync-service.ts` (which doesn't exist yet — Task 8 creates it).

**Storage location:** `oyster.db` (the main spine DB), not `memory.db`. The binding governs every cloud sync service, not just memory.

- [ ] **Step 1: Schema migration**

In `server/src/db.ts` (or wherever `oyster.db` migrations are applied), add (idempotent, additive):

```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS profile_binding (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    cloud_owner_id  TEXT    NOT NULL,
    bound_at        INTEGER NOT NULL
  )
`);
```

The `CHECK (id = 1)` ensures at most one row — the binding is global to the profile.

- [ ] **Step 2: Write failing tests for `ProfileBindingService`**

Create `server/test/profile-binding-service.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { createProfileBindingService } from "../src/profile-binding-service.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE profile_binding (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cloud_owner_id TEXT NOT NULL,
      bound_at INTEGER NOT NULL
    )
  `);
  return db;
}

describe("ProfileBindingService", () => {
  it("getBoundOwner returns null on a fresh profile", () => {
    const svc = createProfileBindingService({ db: freshDb() });
    expect(svc.getBoundOwner()).toBeNull();
  });

  it("bindToOwner binds a fresh profile and reports `bound`", () => {
    const svc = createProfileBindingService({ db: freshDb() });
    expect(svc.bindToOwner("user-A")).toEqual({ bound: true, reason: "bound" });
    expect(svc.getBoundOwner()).toBe("user-A");
  });

  it("bindToOwner is idempotent for the same owner", () => {
    const svc = createProfileBindingService({ db: freshDb() });
    svc.bindToOwner("user-A");
    expect(svc.bindToOwner("user-A")).toEqual({ bound: true, reason: "already_matches" });
  });

  it("bindToOwner refuses a different owner — reports `conflict`", () => {
    const svc = createProfileBindingService({ db: freshDb() });
    svc.bindToOwner("user-A");
    expect(svc.bindToOwner("user-B")).toEqual({ bound: false, reason: "conflict" });
    expect(svc.getBoundOwner()).toBe("user-A"); // binding unchanged
  });

  it("isOwnedBy returns true when binding is null OR matches", () => {
    const svc = createProfileBindingService({ db: freshDb() });
    expect(svc.isOwnedBy("user-A")).toBe(true); // unbound — no conflict yet
    svc.bindToOwner("user-A");
    expect(svc.isOwnedBy("user-A")).toBe(true);
    expect(svc.isOwnedBy("user-B")).toBe(false);
  });

  it("isOwnedBy returns false for null user when bound", () => {
    const svc = createProfileBindingService({ db: freshDb() });
    svc.bindToOwner("user-A");
    expect(svc.isOwnedBy(null)).toBe(false);
  });
});
```

- [ ] **Step 3: Run failing tests**

Run: `cd server && npx vitest run test/profile-binding-service.test.ts`
Expected: file does not exist; module-not-found errors.

- [ ] **Step 4: Implement `ProfileBindingService`**

Create `server/src/profile-binding-service.ts`:

```typescript
// profile-binding-service.ts — one-time binding of the local Oyster profile
// to a single cloud account. Prevents two different Pro users from sharing
// the same local SQLite via cross-device sync. Used by every cloud sync
// service (memory now, spaces and sessions later) before pull or push.

import type Database from "better-sqlite3";

export interface ProfileBindingDeps {
  db: Database.Database;
}

export type BindResult =
  | { bound: true;  reason: "bound" | "already_matches" }
  | { bound: false; reason: "conflict" };

export interface ProfileBindingService {
  /** The currently-bound cloud owner id, or null if the profile is unbound. */
  getBoundOwner(): string | null;
  /** Bind the profile to ownerId. Returns `bound` on first bind,
   *  `already_matches` if the profile is already bound to this same id,
   *  and `conflict` (no change) if a different owner is already bound. */
  bindToOwner(ownerId: string): BindResult;
  /** True if the profile is unbound OR bound to userId. False if bound
   *  to a different user, or if userId is null. Use this as the gate
   *  in cloud sync services. */
  isOwnedBy(userId: string | null): boolean;
}

export function createProfileBindingService(deps: ProfileBindingDeps): ProfileBindingService {
  const getStmt = deps.db.prepare(
    `SELECT cloud_owner_id FROM profile_binding WHERE id = 1`,
  );
  const insertStmt = deps.db.prepare(
    `INSERT INTO profile_binding (id, cloud_owner_id, bound_at) VALUES (1, ?, ?)`,
  );

  function getBoundOwner(): string | null {
    const row = getStmt.get() as { cloud_owner_id: string } | undefined;
    return row?.cloud_owner_id ?? null;
  }

  function bindToOwner(ownerId: string): BindResult {
    const existing = getBoundOwner();
    if (existing === ownerId) return { bound: true, reason: "already_matches" };
    if (existing !== null)    return { bound: false, reason: "conflict" };
    insertStmt.run(ownerId, Date.now());
    return { bound: true, reason: "bound" };
  }

  function isOwnedBy(userId: string | null): boolean {
    if (userId === null) return false;
    const owner = getBoundOwner();
    return owner === null || owner === userId;
  }

  return { getBoundOwner, bindToOwner, isOwnedBy };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run test/profile-binding-service.test.ts`
Expected: 6 passing.

- [ ] **Step 6: Wire a global `canRunCloudSync()` guard into `index.ts`**

The binding gate must apply to **every** cloud sync service — memory now, spaces (already shipped), sessions later. Otherwise a conflicted profile would still leak via existing spaces sync. Implement the check at the orchestration layer.

Construct `profileBinding` near the top of `index.ts` startup, before any sync service:

```typescript
const profileBinding = createProfileBindingService({ db: appDb /* the oyster.db handle */ });
```

Add a top-level helper that **does the bind on first Pro sign-in** and returns whether cloud sync may proceed:

```typescript
/** Gate for every cloud sync service. Returns false when:
 *  - no user is signed in, or
 *  - signed-in user is not Pro, or
 *  - the local Oyster profile is bound to a different account.
 *
 *  Side effect: on first Pro sign-in to an unbound profile, claims the
 *  profile for this user. Idempotent on re-bind for the same user.
 *  This is the single chokepoint — call it from auth-changed AND from
 *  startup, so a persisted Pro session at boot also goes through it. */
function canRunCloudSync(): boolean {
  const u = authService.getState().user;
  if (!u || u.tier !== "pro") return false;

  const result = profileBinding.bindToOwner(u.id);
  if (result.reason === "conflict") {
    console.warn(
      `[profile] cloud sync blocked: profile bound to ${profileBinding.getBoundOwner()}, signed-in user is ${u.id}`,
    );
    // UI surface for this conflict is a follow-up. Emit an SSE notice if
    // the existing broadcast pattern fits cleanly; otherwise just log.
    return false;
  }
  return true;
}
```

Update the auth-changed handler to call `syncOnAuth("auth")` unconditionally — `syncOnAuth` itself will use `canRunCloudSync()` to gate (Task 10 step 3 wires this):

```typescript
authService.onAuthChanged(() => {
  void syncOnAuth("auth");
});
```

Verify the existing startup invocation also routes through `syncOnAuth` (it does today). The `canRunCloudSync` check inside `syncOnAuth` covers both paths.

**Important:** `canRunCloudSync` is the only place that calls `bindToOwner`. Do NOT call `bindToOwner` elsewhere — the side-effect-and-gate combination is intentional, so every entry point that wants to start sync goes through the same chokepoint.

- [ ] **Step 7: Plumb `profileBinding` into existing spaces sync**

Spaces sync was first to ship and currently doesn't gate on profile binding. The orchestration-layer `canRunCloudSync()` covers `spaceSync.reconcile()` (called via `syncOnAuth`), but `spaceService` calls `spaceSync.pushOne(...)` and `spaceSync.pushDelete(...)` after each mutation as fire-and-forget — those bypass `syncOnAuth`. This step closes that gap so the binding gate is enforced on every spaces sync entry point.

Update `server/src/space-sync-service.ts`. Add `profileBinding` to `SpaceSyncDeps`:

```typescript
import type { ProfileBindingService } from "./profile-binding-service.js";

export interface SpaceSyncDeps {
  db: Database.Database;
  store: SpaceStore;
  /** Required: gates pull AND push on profile ownership so a second Pro
   *  account signing into the same local profile cannot push spaces into
   *  the wrong cloud bucket or pull spaces into the wrong local DB.
   *  See Task 4.4 of docs/superpowers/plans/2026-05-08-memory-sync.md. */
  profileBinding: ProfileBindingService;
  currentUser: () => SyncUser | null;
  sessionToken: () => string | null;
  workerBase: string;
  fetch: typeof fetch;
}
```

Update the existing `isProSession` helper inside the file to also check ownership:

```typescript
function isProSession(deps: SpaceSyncDeps): { user: SyncUser; token: string } | null {
  const user = deps.currentUser();
  const token = deps.sessionToken();
  if (!user || !token || user.tier !== "pro") return null;
  if (!deps.profileBinding.isOwnedBy(user.id)) {
    console.warn(
      `[spaces] sync blocked — profile is bound to a different account; current=${user.id}, bound=${deps.profileBinding.getBoundOwner()}`,
    );
    return null;
  }
  return { user, token };
}
```

This single-place change covers all three exposed methods — `reconcile`, `pushOne`, `pushDelete` — because each already calls `isProSession` first and returns zero/no-op when it returns null. No change is needed inside `reconcile`/`pushOne`/`pushDelete` bodies; the gate lives in the helper.

In `server/src/index.ts`, where `createSpaceSyncService(...)` is constructed, pass `profileBinding`:

```typescript
const spaceSync = createSpaceSyncService({
  db: appDb,
  store: spaceStore,
  profileBinding,                         // ← new
  currentUser: () => { /* … existing */ },
  sessionToken: () => authService.getState().sessionToken,
  workerBase: WORKER_BASE,                // spaces stays on oyster-publish for now
  fetch: globalThis.fetch,
});
```

- [ ] **Step 8: Add regression test for the spaces-sync conflict path**

Update `server/test/space-sync-service.test.ts`. Wherever the existing tests construct `createSpaceSyncService`, thread `profileBinding` through the deps (mirror the pattern from `memory-sync-service.test.ts` in Task 8). Existing happy-path tests should bind to the test user before they run.

Add a new test:

```typescript
it("blocks spaces sync when profile is bound to a different owner", async () => {
  const store = makeSpaceStore();                      // existing test helper
  const bindingDb = new Database(":memory:");
  bindingDb.exec(
    `CREATE TABLE profile_binding (id INTEGER PRIMARY KEY CHECK (id=1), cloud_owner_id TEXT NOT NULL, bound_at INTEGER NOT NULL)`,
  );
  const profileBinding = createProfileBindingService({ db: bindingDb });
  profileBinding.bindToOwner("user-A");

  // Pre-seed a dirty space so pushOne has something to send.
  store.create({ id: "space-1", display_name: "S1" });
  store.markSyncDirty("space-1");

  const fetchSpy = vi.fn();
  const svc = createSpaceSyncService({
    db: store["db" as keyof typeof store] as Database.Database,
    store,
    profileBinding,
    currentUser: () => ({ id: "user-B", email: "b@x", tier: "pro" }),
    sessionToken: () => "tok",
    workerBase: "https://example.com",
    fetch: fetchSpy as unknown as typeof fetch,
  });

  // None of the three exposed methods should make a Worker call.
  expect(await svc.reconcile()).toEqual({ pulled: 0, pushed: 0, tombstoned: 0 });
  await svc.pushOne("space-1");
  await svc.pushDelete("space-1");
  expect(fetchSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 9: Smoke-build and run all sync-related tests**

Run: `cd server && npm run build && npx vitest run test/profile-binding-service.test.ts test/space-sync-service.test.ts`
Expected: TypeScript compiles; all profile-binding tests pass; all spaces-sync tests pass (existing + the new regression test).

(Task 8 will plumb `profileBinding` into `MemorySyncService` when that service is created.)

- [ ] **Step 10: Commit**

```bash
git add server/src/db.ts server/src/profile-binding-service.ts server/src/index.ts \
        server/src/space-sync-service.ts \
        server/test/profile-binding-service.test.ts \
        server/test/space-sync-service.test.ts
git commit -m "feat(profile): owner binding gate before cloud sync services (#318)"
```

---

## Task 4.5: Bootstrap `infra/oyster-cloud` Worker

**Goal:** Create the new Cloudflare Worker that will own private signed-in user APIs, starting with memory sync. Empty fetch dispatcher (returns 404 for any path) plus the shared session-resolution machinery copied from `oyster-publish`. No memory-specific routes yet — those land in Tasks 6 and 7.

**Files:**
- Create: `infra/oyster-cloud/package.json`
- Create: `infra/oyster-cloud/tsconfig.json`
- Create: `infra/oyster-cloud/wrangler.toml`
- Create: `infra/oyster-cloud/src/worker.ts`
- Create: `infra/oyster-cloud/src/session.ts` (copy of `resolveSession` + types from `oyster-publish/src/worker.ts`)
- Create: `infra/oyster-cloud/src/json.ts` (copy of `jsonOk` / `jsonError` helpers)
- Create: `infra/oyster-cloud/test/worker.test.ts`
- Create: `infra/oyster-cloud/vitest.config.ts`
- Modify: top-level `package.json` workspaces (if a workspaces array exists; check first)

**Pattern source:** `infra/oyster-publish/` is the reference. Mirror its file layout and idioms; copy auth/json helpers verbatim — these will be deduplicated in a future shared package, but DRY-up is out of scope for this PR.

**Deployment route:** the new Worker binds at `cloud.oyster.to/api/*`. The `wrangler.toml` declares the route; the actual DNS / production rollout is a manual step performed by the maintainer at deploy time (not in this plan).

- [ ] **Step 1: Create `wrangler.toml`**

```toml
name = "oyster-cloud"
main = "src/worker.ts"
compatibility_date = "2025-09-01"

[[d1_databases]]
binding = "DB"
database_name = "oyster-auth"
database_id = "44086805-fbfa-4446-8626-126af7e2ec19"
migrations_dir = "../auth-worker/migrations"

[[routes]]
pattern = "cloud.oyster.to/api/*"
zone_name = "oyster.to"
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "@oyster/cloud-worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "deploy": "wrangler deploy",
    "test": "vitest run"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "*",
    "@cloudflare/workers-types": "*",
    "typescript": "*",
    "vitest": "*",
    "wrangler": "*"
  }
}
```

Use the same dependency versions as `infra/oyster-publish/package.json` — copy them across. Run `npm install` from the new directory after writing.

- [ ] **Step 3: Create `tsconfig.json`**

Copy `infra/oyster-publish/tsconfig.json` verbatim. No changes needed — same target, same compiler options.

- [ ] **Step 4: Create `vitest.config.ts`**

Mirror `infra/oyster-publish/vitest.config.ts`. The key bits: `@cloudflare/vitest-pool-workers` as pool, D1 migration loading from `../auth-worker/migrations/`. If the publish config imports a setup file, copy that too.

- [ ] **Step 5: Create `src/json.ts`**

Copy the `jsonOk` and `jsonError` helpers from `infra/oyster-publish/src/worker.ts` into a standalone module. Same signatures, same behaviour.

```typescript
export function jsonOk(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function jsonError(status: number, code: string, message?: string): Response {
  const body: Record<string, unknown> = { error: code };
  if (message) body.message = message;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
```

- [ ] **Step 6: Create `src/session.ts`**

Copy `resolveSession` and its types from `infra/oyster-publish/src/worker.ts`. This gives the new Worker the same auth surface — same cookie name (`oyster_session`), same SQL, same return shape (`{ id, email, tier }` or null).

- [ ] **Step 7: Create `src/worker.ts` — empty dispatcher**

```typescript
import { jsonError } from "./json.js";
import type { Env } from "./session.js";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Routes for this worker land in Tasks 6 and 7. For now, anything
    // that isn't matched returns 404. Health-check responds 200 for
    // deployment smoke-tests.
    if (url.pathname === "/health" && req.method === "GET") {
      return new Response("ok", { status: 200 });
    }

    return jsonError(404, "not_found");
  },
};
```

(`Env` is the type defined in `session.ts` carrying the D1 binding; mirror what `oyster-publish` does.)

- [ ] **Step 8: Write smoke tests**

Create `infra/oyster-cloud/test/worker.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

describe("oyster-cloud worker bootstrap", () => {
  it("returns 200 for /health", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("returns 404 for unmatched paths", async () => {
    const res = await SELF.fetch("https://example.com/api/anything");
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("D1 binding is wired (smoke check via users table existence)", async () => {
    // The shared oyster-auth migrations should have run; the users table exists.
    const { results } = await import("cloudflare:test").then(({ env }) =>
      env.DB.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='users'`,
      ).all<{ name: string }>(),
    );
    expect(results?.[0]?.name).toBe("users");
  });
});
```

- [ ] **Step 9: Run tests**

Run: `cd infra/oyster-cloud && npm install && npx vitest run`
Expected: 3 passing.

- [ ] **Step 10: Local server config — define `CLOUD_WORKER_BASE`**

In `server/src/index.ts`, where `WORKER_BASE` (used by spaces sync) is defined, add a sibling for the new Worker. Example:

```typescript
const CLOUD_WORKER_BASE = process.env.OYSTER_CLOUD_BASE ?? "https://cloud.oyster.to";
```

This will be passed into `MemorySyncService` in Task 10 instead of reusing `WORKER_BASE`. Local dev can override via env var to point at `http://localhost:8788` or wherever wrangler dev hosts the new Worker.

- [ ] **Step 11: Commit**

```bash
git add infra/oyster-cloud/
git add server/src/index.ts        # only if CLOUD_WORKER_BASE was added now
git commit -m "feat(infra): bootstrap oyster-cloud Worker for private user APIs (#318)"
```

---

## Task 5: Cloud D1 migration — synced_memory_events + synced_memory_payloads

**Goal:** Mirror the local schema in D1 with all four uniqueness constraints from the spec.

**Files:**
- Create: `infra/auth-worker/migrations/0007_synced_memories.sql`
- Create: `infra/oyster-cloud/test/memories-events.test.ts` — verify migration applies (this is the same test file used by Tasks 6 and 7).

- [ ] **Step 1: Write the migration file**

Create `infra/auth-worker/migrations/0007_synced_memories.sql`:

```sql
-- 0007_synced_memories.sql — cross-device memory sync substrate (#318).
-- Spec: docs/superpowers/specs/2026-05-08-memory-sync-design.md
--
-- Append-only event log + redactable payload store. Per-type uniqueness
-- enforces the spec's idempotent-replay invariants. Pro-only writes; gate
-- enforced on the Worker handler.

CREATE TABLE IF NOT EXISTS synced_memory_events (
  owner_id        TEXT    NOT NULL,
  event_id        TEXT    NOT NULL,
  memory_id       TEXT    NOT NULL,
  event_type      TEXT    NOT NULL CHECK (event_type IN ('memory_created','memory_forgotten','memory_purged')),
  space_id        TEXT,                -- meaningful only when event_type = 'memory_created'
  created_at      INTEGER NOT NULL,    -- unix ms; not used for LWW, just ordering
  ingested_at     INTEGER NOT NULL,    -- when the cloud accepted the event
  PRIMARY KEY (owner_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_synced_memory_events_owner_created
  ON synced_memory_events (owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_synced_memory_events_memory
  ON synced_memory_events (owner_id, memory_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_synced_memory_created
  ON synced_memory_events (owner_id, memory_id) WHERE event_type = 'memory_created';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_synced_memory_forgotten
  ON synced_memory_events (owner_id, memory_id) WHERE event_type = 'memory_forgotten';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_synced_memory_purged
  ON synced_memory_events (owner_id, memory_id) WHERE event_type = 'memory_purged';

CREATE TABLE IF NOT EXISTS synced_memory_payloads (
  owner_id   TEXT NOT NULL,
  memory_id  TEXT NOT NULL,
  content    TEXT,                     -- NULL after purge
  tags       TEXT NOT NULL DEFAULT '[]',
  purged_at  INTEGER,                  -- non-NULL after purge
  PRIMARY KEY (owner_id, memory_id)
);
```

- [ ] **Step 2: Apply the migration locally for development**

Run from the repo root:

```bash
cd infra/auth-worker
npx wrangler d1 migrations apply oyster-auth --local
```

Expected: migration applies cleanly. Re-running is a no-op.

- [ ] **Step 3: Write a smoke test that the table exists in test D1**

Worker tests run with `@cloudflare/vitest-pool-workers`. Migrations are applied via `wrangler d1 migrations apply --local` before the suite runs (or via the project's existing test setup — check `infra/oyster-publish/vitest.config.ts` and the corresponding `setup` file used by spaces tests; mirror its migration-loading mechanism). Create a new file `infra/oyster-cloud/test/memories-events.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

describe("synced_memory_events / synced_memory_payloads schema", () => {
  it("has the events table with expected columns", async () => {
    const { results } = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('synced_memory_events') ORDER BY name`,
    ).all<{ name: string }>();
    const names = (results ?? []).map((r) => r.name);
    expect(names).toEqual([
      "created_at", "event_id", "event_type", "ingested_at", "memory_id", "owner_id", "space_id",
    ]);
  });

  it("has the payloads table with expected columns", async () => {
    const { results } = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('synced_memory_payloads') ORDER BY name`,
    ).all<{ name: string }>();
    const names = (results ?? []).map((r) => r.name);
    expect(names).toEqual(["content", "memory_id", "owner_id", "purged_at", "tags"]);
  });

  it("enforces per-type uniqueness on memory_created", async () => {
    await env.DB.prepare(
      `INSERT INTO synced_memory_events (owner_id, event_id, memory_id, event_type, space_id, created_at, ingested_at)
       VALUES ('user-A', 'ev-1', 'mem-1', 'memory_created', NULL, 1000, 2000)`,
    ).run();
    await expect(env.DB.prepare(
      `INSERT INTO synced_memory_events (owner_id, event_id, memory_id, event_type, space_id, created_at, ingested_at)
       VALUES ('user-A', 'ev-2', 'mem-1', 'memory_created', NULL, 1500, 2500)`,
    ).run()).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Run worker tests to verify schema**

Run: `cd infra/oyster-cloud && npx vitest run test/memories-events.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add infra/auth-worker/migrations/0007_synced_memories.sql infra/oyster-cloud/test/memories-events.test.ts
git commit -m "feat(d1): synced_memory_events + synced_memory_payloads schema (#318)"
```

---

## Task 6: Worker route POST /api/memories/events — idempotent ingestion + Pro gate

**Goal:** Accept event batches from a Pro client, idempotently ingest into D1. For `memory_created`, also upsert payload content. For `memory_purged`, null payload content. Return per-event status.

**Wire format (request):**

```json
{
  "events": [
    {
      "event_id": "uuid",
      "memory_id": "uuid",
      "event_type": "memory_created",
      "space_id": null,
      "created_at": 1730000000000,
      "payload": { "content": "...", "tags": ["..."] }
    }
  ]
}
```

For `memory_forgotten` and `memory_purged`, `payload` is omitted. Server ignores `payload` on non-created events.

**Wire format (response):**

```json
{
  "accepted":   ["..."],   // newly inserted events; client marks synced
  "duplicates": ["..."],   // event_id already in cloud (idempotent retry); client marks synced
  "conflicts":  ["..."],   // per-type uniqueness rejected (e.g. second memory_created for same memory_id); client does NOT mark synced — warns and triggers pull/reconcile so cloud's authoritative state lands locally
  "rejected":   ["..."]    // malformed / disallowed (e.g. memory_created without payload, no prior purge); client does NOT mark synced — surfaces a warning, stays pending
}
```

The four-way split matters: only `accepted` and `duplicates` are safe to mark `cloud_synced_at`. `conflicts` and `rejected` stay pending. Conflicts trigger a follow-up pull (cloud may have content the local replica needs); rejected events stay surfaced so a client bug doesn't silently drop user data.

**Precedence ordering at ingest:** the worker sorts incoming events within each batch by precedence (purges first, then forgets, then creates), then by `created_at` ascending. This matters because the client may push a `memory_created` whose payload was already nulled locally (because a purge for the same `memory_id` was queued behind it). Processing the purge first means the create lands with the correct redaction even when the events arrive in write-order from the client.

**Files:**
- Modify: `infra/oyster-cloud/src/worker.ts` (route handler + dispatch)
- Modify: `infra/oyster-cloud/test/memories-events.test.ts`

- [ ] **Step 1: Wire the route in the dispatcher**

In `infra/oyster-cloud/src/worker.ts`, in the main `fetch` block, before the final `return jsonError(404, "not_found");`:

```typescript
    if (url.pathname === "/api/memories/events" && req.method === "POST") {
      return handleMemoryEventsPost(req, env);
    }
    if (url.pathname === "/api/memories/events" && req.method === "GET") {
      return handleMemoryEventsGet(req, env, url);
    }
```

- [ ] **Step 2: Write failing tests for POST**

Append to `infra/oyster-cloud/test/memories-events.test.ts`:

```typescript
import { SELF } from "cloudflare:test";

async function signedInRequest(path: string, init: RequestInit, sessionToken: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", `oyster_session=${sessionToken}`);
  return SELF.fetch(`https://example.com${path}`, { ...init, headers });
}

async function makeProSession(env: Env): Promise<{ token: string; userId: string }> {
  // Helper: insert a Pro user + active session. Mirror what spaces tests do.
  const userId = "u-pro-1";
  const token  = "tok-pro-1";
  await env.DB.prepare(`INSERT INTO users (id, email, tier) VALUES (?, ?, 'pro')`).bind(userId, "pro@example.com").run();
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL)`,
  ).bind(token, userId, Date.now(), Date.now() + 86400_000).run();
  return { token, userId };
}

describe("POST /api/memories/events", () => {
  it("rejects unsigned requests with 401", async () => {
    const res = await SELF.fetch("https://example.com/api/memories/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects free-tier users with 403", async () => {
    const userId = "u-free-1";
    const token  = "tok-free-1";
    await env.DB.prepare(`INSERT INTO users (id, email, tier) VALUES (?, ?, 'free')`).bind(userId, "free@example.com").run();
    await env.DB.prepare(
      `INSERT INTO sessions (token, user_id, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL)`,
    ).bind(token, userId, Date.now(), Date.now() + 86400_000).run();

    const res = await signedInRequest("/api/memories/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [] }),
    }, token);
    expect(res.status).toBe(403);
  });

  it("ingests a memory_created event with payload", async () => {
    const { token, userId } = await makeProSession(env);
    const res = await signedInRequest("/api/memories/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{
          event_id:  "ev-1",
          memory_id: "mem-1",
          event_type: "memory_created",
          space_id: null,
          created_at: 1000,
          payload: { content: "hello", tags: ["a"] },
        }],
      }),
    }, token);
    expect(res.status).toBe(200);
    const body = await res.json() as { accepted: string[]; duplicates: string[]; conflicts: string[]; rejected: string[] };
    expect(body.accepted).toEqual(["ev-1"]);
    expect(body.duplicates).toEqual([]);
    expect(body.conflicts).toEqual([]);
    expect(body.rejected).toEqual([]);

    const ev = await env.DB.prepare(
      `SELECT event_type FROM synced_memory_events WHERE owner_id = ? AND event_id = ?`,
    ).bind(userId, "ev-1").first<{ event_type: string }>();
    expect(ev?.event_type).toBe("memory_created");

    const pay = await env.DB.prepare(
      `SELECT content FROM synced_memory_payloads WHERE owner_id = ? AND memory_id = ?`,
    ).bind(userId, "mem-1").first<{ content: string }>();
    expect(pay?.content).toBe("hello");
  });

  it("duplicate event_id is reported as `duplicates`, not `accepted`", async () => {
    const { token } = await makeProSession(env);
    const event = {
      event_id:  "ev-dup",
      memory_id: "mem-dup",
      event_type: "memory_created" as const,
      space_id: null,
      created_at: 1000,
      payload: { content: "x", tags: [] },
    };
    const first  = await signedInRequest("/api/memories/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [event] }) }, token);
    expect((await first.json() as any).accepted).toEqual(["ev-dup"]);
    const second = await signedInRequest("/api/memories/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [event] }) }, token);
    const body = await second.json() as { accepted: string[]; duplicates: string[]; conflicts: string[]; rejected: string[] };
    expect(body.duplicates).toEqual(["ev-dup"]);
    expect(body.accepted).toEqual([]);
  });

  it("second create for same memory_id with different event_id is `conflicts`", async () => {
    const { token } = await makeProSession(env);
    const first  = await signedInRequest("/api/memories/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ event_id: "ev-A", memory_id: "mem-Z", event_type: "memory_created", space_id: null, created_at: 1000, payload: { content: "first", tags: [] } }] }) }, token);
    expect((await first.json() as any).accepted).toEqual(["ev-A"]);
    const second = await signedInRequest("/api/memories/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ event_id: "ev-B", memory_id: "mem-Z", event_type: "memory_created", space_id: null, created_at: 2000, payload: { content: "second", tags: [] } }] }) }, token);
    const body = await second.json() as { accepted: string[]; conflicts: string[] };
    expect(body.conflicts).toEqual(["ev-B"]);
  });

  it("rejects malformed events; surfaces them in `rejected`", async () => {
    const { token } = await makeProSession(env);
    const res = await signedInRequest("/api/memories/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          { event_id: "ev-good", memory_id: "mem-G", event_type: "memory_created", space_id: null, created_at: 1, payload: { content: "ok", tags: [] } },
          { event_id: "ev-bad-type", memory_id: "mem-B1", event_type: "lol", space_id: null, created_at: 1 },
          { event_id: "ev-bad-empty-id", memory_id: "", event_type: "memory_created", space_id: null, created_at: 1, payload: { content: "x", tags: [] } },
          { event_id: "", memory_id: "mem-B3", event_type: "memory_created", space_id: null, created_at: 1, payload: { content: "x", tags: [] } },
        ],
      }),
    }, token);
    const body = await res.json() as { accepted: string[]; rejected: string[] };
    expect(body.accepted).toEqual(["ev-good"]);
    expect(body.rejected).toEqual(expect.arrayContaining(["ev-bad-type", "ev-bad-empty-id"]));
  });

  it("rejects memory_created without payload when no purge exists", async () => {
    const { token } = await makeProSession(env);
    const res = await signedInRequest("/api/memories/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{ event_id: "ev-empty", memory_id: "mem-E", event_type: "memory_created", space_id: null, created_at: 1 }],
      }),
    }, token);
    const body = await res.json() as { accepted: string[]; rejected: string[] };
    expect(body.rejected).toEqual(["ev-empty"]);
    expect(body.accepted).toEqual([]);
  });

  it("accepts memory_created without payload when a purge already exists in the same batch (sorted first)", async () => {
    const { token, userId } = await makeProSession(env);
    const res = await signedInRequest("/api/memories/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          // Client writes create then purge; sort puts purge first.
          { event_id: "ev-c", memory_id: "mem-Y", event_type: "memory_created", space_id: null, created_at: 1000 },
          { event_id: "ev-p", memory_id: "mem-Y", event_type: "memory_purged",  space_id: null, created_at: 2000 },
        ],
      }),
    }, token);
    const body = await res.json() as { accepted: string[]; rejected: string[] };
    expect(body.accepted.sort()).toEqual(["ev-c", "ev-p"].sort());
    expect(body.rejected).toEqual([]);
    const pay = await env.DB.prepare(
      `SELECT content, purged_at FROM synced_memory_payloads WHERE owner_id = ? AND memory_id = ?`,
    ).bind(userId, "mem-Y").first<{ content: string | null; purged_at: number | null }>();
    expect(pay?.content).toBeNull();
    expect(pay?.purged_at).not.toBeNull();
  });

  it("memory_purged nulls payload content even if create arrives later", async () => {
    const { token, userId } = await makeProSession(env);
    // Send purge first (out-of-order delivery).
    await signedInRequest("/api/memories/events", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{
          event_id: "ev-purge", memory_id: "mem-X", event_type: "memory_purged",
          space_id: null, created_at: 2000,
        }],
      }),
    }, token);
    // Then send create with content.
    await signedInRequest("/api/memories/events", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{
          event_id: "ev-create", memory_id: "mem-X", event_type: "memory_created",
          space_id: null, created_at: 1000,
          payload: { content: "should-not-survive", tags: [] },
        }],
      }),
    }, token);
    const pay = await env.DB.prepare(
      `SELECT content, purged_at FROM synced_memory_payloads WHERE owner_id = ? AND memory_id = ?`,
    ).bind(userId, "mem-X").first<{ content: string | null; purged_at: number | null }>();
    expect(pay?.content).toBeNull();
    expect(pay?.purged_at).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run failing tests**

Run: `cd infra/oyster-cloud && npx vitest run test/memories-events.test.ts -t "POST"`
Expected: 5 failures — handlers don't exist.

- [ ] **Step 4: Implement `handleMemoryEventsPost`**

In `infra/oyster-cloud/src/worker.ts`, after the dispatcher (define handlers below the `export default` block, mirroring `oyster-publish`'s structure):

```typescript
async function handleMemoryEventsPost(req: Request, env: Env): Promise<Response> {
  // resolveSession + jsonOk/jsonError come from `./session.js` and `./json.js`
  // respectively (created in Task 4.5). Add explicit imports at top of file.
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");
  if (user.tier !== "pro") return jsonError(403, "pro_required");

  type IncomingEvent = {
    event_id: string;
    memory_id: string;
    event_type: "memory_created" | "memory_forgotten" | "memory_purged";
    space_id: string | null;
    created_at: number;
    payload?: { content: string; tags: string[] };
  };
  let body: { events?: IncomingEvent[] };
  try { body = await req.json() as typeof body; }
  catch { return jsonError(400, "invalid_metadata"); }

  const incoming = body.events ?? [];
  if (!Array.isArray(incoming)) return jsonError(400, "invalid_metadata");

  const accepted:   string[] = [];
  const duplicates: string[] = [];
  const conflicts:  string[] = [];
  const rejected:   string[] = [];

  // Validate each event up-front. Rejected events are NOT marked synced by
  // the client — they surface as warnings.
  function isValidEvent(ev: unknown): ev is IncomingEvent {
    if (!ev || typeof ev !== "object") return false;
    const e = ev as Record<string, unknown>;
    if (typeof e.event_id !== "string" || e.event_id.length === 0) return false;
    if (typeof e.memory_id !== "string" || e.memory_id.length === 0) return false;
    if (e.event_type !== "memory_created" && e.event_type !== "memory_forgotten" && e.event_type !== "memory_purged") return false;
    if (typeof e.created_at !== "number" || !Number.isFinite(e.created_at) || e.created_at < 0) return false;
    if (e.space_id !== null && typeof e.space_id !== "string") return false;
    if (e.event_type === "memory_created" && e.payload !== undefined) {
      const p = e.payload as Record<string, unknown>;
      if (!p || typeof p !== "object") return false;
      if (typeof p.content !== "string") return false;
      if (!Array.isArray(p.tags) || !p.tags.every((t) => typeof t === "string")) return false;
    }
    return true;
  }

  const valid: IncomingEvent[] = [];
  for (const raw of incoming) {
    if (!isValidEvent(raw)) {
      const id = (raw as { event_id?: unknown })?.event_id;
      rejected.push(typeof id === "string" ? id : "<malformed>");
      continue;
    }
    valid.push(raw);
  }

  // Precedence-first ordering: purges, then forgets, then creates. Within each
  // bucket, sort by created_at ascending. This ensures a `memory_created`
  // event whose payload was nulled locally before sync (purge-arrives-second
  // from the client) lands AFTER any same-batch purge has been recorded, so
  // the payload-upsert query naturally suppresses the content.
  const PRECEDENCE: Record<IncomingEvent["event_type"], number> = {
    memory_purged: 0, memory_forgotten: 1, memory_created: 2,
  };
  valid.sort((a, b) => PRECEDENCE[a.event_type] - PRECEDENCE[b.event_type] || a.created_at - b.created_at);

  // Track which memory_ids have a purge in this batch — combined with the
  // existing-purge check in DB, used to validate empty-payload creates.
  const purgedInBatch = new Set<string>();
  for (const ev of valid) if (ev.event_type === "memory_purged") purgedInBatch.add(ev.memory_id);

  const now = Date.now();
  for (const ev of valid) {
    // Reject memory_created without payload UNLESS a purge already exists
    // for this memory_id (in cloud OR earlier in this batch). Otherwise an
    // empty-payload create would land an unrecoverable empty memory.
    if (ev.event_type === "memory_created" && !ev.payload) {
      const existingPurge = await env.DB.prepare(
        `SELECT 1 FROM synced_memory_events
          WHERE owner_id = ? AND memory_id = ? AND event_type = 'memory_purged' LIMIT 1`,
      ).bind(user.id, ev.memory_id).first();
      if (!existingPurge && !purgedInBatch.has(ev.memory_id)) {
        rejected.push(ev.event_id);
        continue;
      }
    }

    // Build the event-insert + payload statement atomically via env.DB.batch.
    // Each event's pair runs as one D1 transaction — no half-applied state.
    const eventStmt = env.DB.prepare(
      `INSERT OR IGNORE INTO synced_memory_events
         (owner_id, event_id, memory_id, event_type, space_id, created_at, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(user.id, ev.event_id, ev.memory_id, ev.event_type, ev.space_id, ev.created_at, now);

    let payloadStmt: ReturnType<typeof env.DB.prepare> | null = null;
    if (ev.event_type === "memory_purged") {
      payloadStmt = env.DB.prepare(
        `INSERT INTO synced_memory_payloads (owner_id, memory_id, content, tags, purged_at)
         VALUES (?, ?, NULL, '[]', ?)
         ON CONFLICT(owner_id, memory_id) DO UPDATE SET
           content   = NULL,
           tags      = '[]',
           purged_at = excluded.purged_at`,
      ).bind(user.id, ev.memory_id, ev.created_at);
    } else if (ev.event_type === "memory_created" && ev.payload) {
      // Idempotent payload upsert that respects an earlier purge.
      // If a purge exists for this memory_id (in cloud), content stays NULL.
      payloadStmt = env.DB.prepare(
        `INSERT INTO synced_memory_payloads (owner_id, memory_id, content, tags, purged_at)
           SELECT ?, ?, ?, ?, NULL
            WHERE NOT EXISTS (
              SELECT 1 FROM synced_memory_events
               WHERE owner_id = ? AND memory_id = ? AND event_type = 'memory_purged'
            )
         ON CONFLICT(owner_id, memory_id) DO UPDATE SET
           content = CASE
             WHEN EXISTS (SELECT 1 FROM synced_memory_events
                            WHERE owner_id = synced_memory_payloads.owner_id
                              AND memory_id = synced_memory_payloads.memory_id
                              AND event_type = 'memory_purged')
               THEN NULL
             ELSE excluded.content
           END,
           tags = CASE
             WHEN EXISTS (SELECT 1 FROM synced_memory_events
                            WHERE owner_id = synced_memory_payloads.owner_id
                              AND memory_id = synced_memory_payloads.memory_id
                              AND event_type = 'memory_purged')
               THEN '[]'
             ELSE excluded.tags
           END`,
      ).bind(
        user.id, ev.memory_id, ev.payload.content, JSON.stringify(ev.payload.tags),
        user.id, ev.memory_id,
      );
    }

    const stmts = payloadStmt ? [eventStmt, payloadStmt] : [eventStmt];
    const results = await env.DB.batch(stmts);
    const eventChanges = results[0].meta.changes;

    if (eventChanges > 0) {
      accepted.push(ev.event_id);
      continue;
    }

    // Event INSERT was a no-op. Distinguish duplicate event_id from per-type
    // uniqueness conflict. The PK is (owner_id, event_id); per-type partial
    // unique indexes cover (owner_id, memory_id, event_type) WHERE the type
    // matches. Both are safely idempotent — caller marks them synced.
    const dup = await env.DB.prepare(
      `SELECT 1 FROM synced_memory_events WHERE owner_id = ? AND event_id = ? LIMIT 1`,
    ).bind(user.id, ev.event_id).first();
    if (dup) duplicates.push(ev.event_id);
    else conflicts.push(ev.event_id);
  }

  return jsonOk({ accepted, duplicates, conflicts, rejected });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd infra/oyster-cloud && npx vitest run test/memories-events.test.ts -t "POST"`
Expected: 5 passing.

- [ ] **Step 6: Commit**

```bash
git add infra/oyster-cloud/src/worker.ts infra/oyster-cloud/test/memories-events.test.ts
git commit -m "feat(worker): POST /api/memories/events with idempotent ingest + Pro gate (#318)"
```

---

## Task 7: Worker route GET /api/memories/events

**Goal:** Pull all events for the signed-in Pro user, joined with payload state, ordered by `created_at`. No pagination in v1 — memories are tiny; full mirror per device is the design.

**Files:**
- Modify: `infra/oyster-cloud/src/worker.ts`
- Modify: `infra/oyster-cloud/test/memories-events.test.ts`

**Wire format (response):**

```json
{
  "events": [
    {
      "event_id": "...",
      "memory_id": "...",
      "event_type": "memory_created",
      "space_id": null,
      "created_at": 1000,
      "payload": { "content": "...", "tags": ["..."], "purged_at": null }
    },
    { "event_id": "...", "event_type": "memory_forgotten", ... }
  ]
}
```

`payload` is included only on `memory_created` rows, and content reflects current redaction state (NULL after purge).

- [ ] **Step 1: Write failing test**

Append to `infra/oyster-cloud/test/memories-events.test.ts`:

```typescript
describe("GET /api/memories/events", () => {
  it("rejects unsigned with 401", async () => {
    const res = await SELF.fetch("https://example.com/api/memories/events");
    expect(res.status).toBe(401);
  });

  it("returns all events for the signed-in user, ordered by created_at", async () => {
    const { token, userId } = await makeProSession(env);
    await env.DB.prepare(
      `INSERT INTO synced_memory_events (owner_id, event_id, memory_id, event_type, space_id, created_at, ingested_at)
       VALUES (?, 'ev-A', 'mem-1', 'memory_created', NULL, 1000, 1000),
              (?, 'ev-B', 'mem-1', 'memory_forgotten', NULL, 2000, 2000)`,
    ).bind(userId, userId).run();
    await env.DB.prepare(
      `INSERT INTO synced_memory_payloads (owner_id, memory_id, content, tags, purged_at)
       VALUES (?, 'mem-1', 'hello', '["a"]', NULL)`,
    ).bind(userId).run();

    const res = await signedInRequest("/api/memories/events", { method: "GET" }, token);
    expect(res.status).toBe(200);
    const body = await res.json() as { events: Array<{ event_id: string; event_type: string; payload?: { content: string | null } }> };
    expect(body.events.map((e) => e.event_id)).toEqual(["ev-A", "ev-B"]);
    expect(body.events[0].payload?.content).toBe("hello");
    expect(body.events[1].payload).toBeUndefined();
  });

  it("excludes other users' events", async () => {
    const { token: tokenA, userId: idA } = await makeProSession(env);
    const idB = "u-pro-2";
    await env.DB.prepare(`INSERT INTO users (id, email, tier) VALUES (?, ?, 'pro')`).bind(idB, "b@x.com").run();
    await env.DB.prepare(
      `INSERT INTO synced_memory_events (owner_id, event_id, memory_id, event_type, space_id, created_at, ingested_at)
       VALUES (?, 'ev-other', 'mem-other', 'memory_created', NULL, 100, 100)`,
    ).bind(idB).run();

    const res = await signedInRequest("/api/memories/events", { method: "GET" }, tokenA);
    const body = await res.json() as { events: Array<{ event_id: string }> };
    expect(body.events.find((e) => e.event_id === "ev-other")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `cd infra/oyster-cloud && npx vitest run test/memories-events.test.ts -t "GET"`
Expected: 3 failures.

- [ ] **Step 3: Implement `handleMemoryEventsGet`**

In `infra/oyster-cloud/src/worker.ts`, after `handleMemoryEventsPost`:

```typescript
async function handleMemoryEventsGet(req: Request, env: Env, _url: URL): Promise<Response> {
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");
  if (user.tier !== "pro") return jsonError(403, "pro_required");

  type EventRow = {
    event_id: string; memory_id: string; event_type: string;
    space_id: string | null; created_at: number;
    p_content: string | null; p_tags: string | null; p_purged_at: number | null;
  };
  const { results } = await env.DB.prepare(
    `SELECT e.event_id, e.memory_id, e.event_type, e.space_id, e.created_at,
            p.content   AS p_content,
            p.tags      AS p_tags,
            p.purged_at AS p_purged_at
       FROM synced_memory_events e
       LEFT JOIN synced_memory_payloads p
         ON p.owner_id = e.owner_id AND p.memory_id = e.memory_id
      WHERE e.owner_id = ?
      ORDER BY e.created_at ASC`,
  ).bind(user.id).all<EventRow>();

  const events = (results ?? []).map((r) => {
    const base = {
      event_id: r.event_id,
      memory_id: r.memory_id,
      event_type: r.event_type,
      space_id: r.space_id,
      created_at: r.created_at,
    };
    if (r.event_type === "memory_created") {
      return {
        ...base,
        payload: {
          content: r.p_content,
          tags: r.p_tags ? JSON.parse(r.p_tags) : [],
          purged_at: r.p_purged_at,
        },
      };
    }
    return base;
  });

  return jsonOk({ events }, 200, { "cache-control": "private, no-store" });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd infra/oyster-cloud && npx vitest run test/memories-events.test.ts -t "GET"`
Expected: 3 passing.

- [ ] **Step 5: Run full worker test suite to confirm no regressions**

Run: `cd infra/oyster-cloud && npx vitest run`
Expected: all passing — bootstrap tests (Task 4.5), POST tests (Task 6), GET tests (Task 7).

- [ ] **Step 6: Commit**

```bash
git add infra/oyster-cloud/src/worker.ts infra/oyster-cloud/test/memories-events.test.ts
git commit -m "feat(worker): GET /api/memories/events with payload join + Pro gate (#318)"
```

---

## Task 8: MemorySyncService — pushPending + pull + reconcile

**Goal:** Local service mirroring `space-sync-service.ts`. Push pending events from the outbox, pull cloud events and replay locally with precedence, expose `reconcile()` for auth/startup hooks. Pro-only.

**Files:**
- Create: `server/src/memory-sync-service.ts`
- Create: `server/test/memory-sync-service.test.ts`

- [ ] **Step 1: Define the contract + write failing tests**

Create `server/test/memory-sync-service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { SqliteFtsMemoryProvider } from "../src/memory-store.js";
import { createMemorySyncService } from "../src/memory-sync-service.js";
import { createProfileBindingService } from "../src/profile-binding-service.js";

function harness() {
  const tmp = mkdtempSync(join(tmpdir(), "memsync-"));
  const provider = new SqliteFtsMemoryProvider(tmp);
  // Each test gets its own profile_binding table in a separate in-memory DB
  // so binding state doesn't bleed between tests.
  const bindingDb = new Database(":memory:");
  bindingDb.exec(
    `CREATE TABLE profile_binding (id INTEGER PRIMARY KEY CHECK (id=1), cloud_owner_id TEXT NOT NULL, bound_at INTEGER NOT NULL)`,
  );
  const profileBinding = createProfileBindingService({ db: bindingDb });
  return { tmp, provider, profileBinding };
}

describe("MemorySyncService", () => {
  it("reconcile is a no-op for free users", async () => {
    const { provider, profileBinding } = harness();
    await provider.init();
    const fetchSpy = vi.fn();
    const svc = createMemorySyncService({
      db: (provider as any).db,
      provider,
      profileBinding,
      currentUser: () => ({ id: "u1", email: "x@x", tier: "free" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy,
    });
    const r = await svc.reconcile();
    expect(r).toEqual({ pulled: 0, pushed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reconcile is a no-op when profile is bound to a different account", async () => {
    const { provider, profileBinding } = harness();
    await provider.init();
    profileBinding.bindToOwner("user-A");

    const fetchSpy = vi.fn();
    const svc = createMemorySyncService({
      db: (provider as any).db,
      provider,
      profileBinding,
      currentUser: () => ({ id: "user-B", email: "b@x", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy,
    });
    const r = await svc.reconcile();
    expect(r).toEqual({ pulled: 0, pushed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("pushPending sends pending events and marks them synced", async () => {
    const { provider, profileBinding } = harness();
    await provider.init();
    profileBinding.bindToOwner("u1");
    const m = await provider.remember({ content: "hello", cloud_owner_id: "u1" });

    // Mock: server accepts whatever event_ids we send.
    const fetchSpy = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { events: Array<{ event_id: string }> };
      return new Response(
        JSON.stringify({
          accepted: body.events.map((e) => e.event_id),
          duplicates: [], conflicts: [], rejected: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const svc = createMemorySyncService({
      db: (provider as any).db,
      provider,
      profileBinding,
      currentUser: () => ({ id: "u1", email: "x@x", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });

    const pushed = await svc.pushPending();
    expect(pushed).toBe(1);
    expect(fetchSpy).toHaveBeenCalledOnce();

    // Pending row count should drop to 0.
    const db = (provider as any).db as Database.Database;
    const c = db.prepare(`SELECT COUNT(*) as c FROM memory_events WHERE cloud_synced_at IS NULL`).get() as { c: number };
    expect(c.c).toBe(0);
  });

  it("pull applies remote events and materialises memories locally", async () => {
    const { provider, profileBinding } = harness();
    await provider.init();
    profileBinding.bindToOwner("u1");

    const fetchSpy = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        events: [
          {
            event_id:  "ev-r1",
            memory_id: "mem-r1",
            event_type: "memory_created",
            space_id: null,
            created_at: 1000,
            payload: { content: "from-cloud", tags: [], purged_at: null },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const svc = createMemorySyncService({
      db: (provider as any).db,
      provider,
      profileBinding,
      currentUser: () => ({ id: "u1", email: "x@x", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });

    const pulled = await svc.pull();
    expect(pulled).toBe(1);
    const list = await provider.list();
    expect(list.find((m) => m.id === "mem-r1")?.content).toBe("from-cloud");
  });

  it("pull marks a local pending event as synced when it appears in cloud", async () => {
    const { provider, profileBinding } = harness();
    await provider.init();
    profileBinding.bindToOwner("u1");
    // Local creates a memory; the event is pending (cloud_synced_at IS NULL).
    const m = await provider.remember({ content: "round-trip", cloud_owner_id: "u1" });
    const db = (provider as any).db as Database.Database;
    const localEvent = db.prepare(
      `SELECT event_id, cloud_synced_at FROM memory_events WHERE memory_id = ?`,
    ).get(m.id) as { event_id: string; cloud_synced_at: number | null };
    expect(localEvent.cloud_synced_at).toBeNull();

    // Cloud's GET returns the same event_id (e.g. push went through but the
    // response was lost; the event is in cloud, local thinks it's pending).
    const fetchSpy = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        events: [{
          event_id:  localEvent.event_id,
          memory_id: m.id,
          event_type: "memory_created",
          space_id: null,
          created_at: 1000,
          payload: { content: "round-trip", tags: [], purged_at: null },
        }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const svc = createMemorySyncService({
      db, provider,
      profileBinding,
      currentUser: () => ({ id: "u1", email: "x@x", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });

    await svc.pull();

    const after = db.prepare(
      `SELECT cloud_synced_at FROM memory_events WHERE event_id = ?`,
    ).get(localEvent.event_id) as { cloud_synced_at: number | null };
    expect(after.cloud_synced_at).not.toBeNull();
  });

  it("pull respects purge precedence — late create does not restore content", async () => {
    const { provider, profileBinding } = harness();
    await provider.init();
    profileBinding.bindToOwner("u1");

    const fetchSpy = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        events: [
          { event_id: "ev-purge",  memory_id: "mem-X", event_type: "memory_purged",  space_id: null, created_at: 2000 },
          { event_id: "ev-create", memory_id: "mem-X", event_type: "memory_created", space_id: null, created_at: 1000, payload: { content: "leak", tags: [], purged_at: null } },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const svc = createMemorySyncService({
      db: (provider as any).db,
      provider,
      profileBinding,
      currentUser: () => ({ id: "u1", email: "x@x", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });

    await svc.pull();
    const list = await provider.list();
    expect(list).toHaveLength(0);
    const found = await provider.recall({ query: "leak" });
    expect(found).toHaveLength(0);
  });

  it("network errors during push are swallowed; events stay pending", async () => {
    const { provider, profileBinding } = harness();
    await provider.init();
    profileBinding.bindToOwner("u1");
    await provider.remember({ content: "stays-dirty", cloud_owner_id: "u1" });

    const fetchSpy = vi.fn().mockRejectedValue(new TypeError("network"));
    const svc = createMemorySyncService({
      db: (provider as any).db,
      provider,
      profileBinding,
      currentUser: () => ({ id: "u1", email: "x@x", tier: "pro" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy as unknown as typeof fetch,
    });

    const pushed = await svc.pushPending();
    expect(pushed).toBe(0);

    const db = (provider as any).db as Database.Database;
    const c = db.prepare(`SELECT COUNT(*) as c FROM memory_events WHERE cloud_synced_at IS NULL`).get() as { c: number };
    expect(c.c).toBe(1);
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `cd server && npx vitest run test/memory-sync-service.test.ts`
Expected: 5 failures (file does not exist).

- [ ] **Step 3: Implement the service**

Create `server/src/memory-sync-service.ts`:

```typescript
// memory-sync-service.ts — cross-device sync of the local memory store (#318).
// Spec: docs/superpowers/specs/2026-05-08-memory-sync-design.md
//
// Pattern: append-only event log + redactable payload store. Push pending
// events from the outbox; pull cloud events and replay locally using the
// precedence rule purged > forgotten > created. Pro-only. Reconcile runs on
// sign-in and at app start.

import type Database from "better-sqlite3";
import type { SqliteFtsMemoryProvider } from "./memory-store.js";
import type { ProfileBindingService } from "./profile-binding-service.js";

interface SyncUser { id: string; email: string; tier: string }

export interface MemorySyncDeps {
  db: Database.Database;
  provider: SqliteFtsMemoryProvider;
  /** Required: gates pull AND push on profile ownership so a second Pro
   *  account signing into the same local profile cannot pollute the local
   *  SQLite with their cloud events. See Task 4.4. */
  profileBinding: ProfileBindingService;
  currentUser: () => SyncUser | null;
  sessionToken: () => string | null;
  workerBase: string;
  fetch: typeof fetch;
}

export interface MemorySyncService {
  reconcile(): Promise<{ pulled: number; pushed: number }>;
  pushPending(): Promise<number>;
  pull(): Promise<number>;
}

interface OutgoingEvent {
  event_id: string;
  memory_id: string;
  event_type: "memory_created" | "memory_forgotten" | "memory_purged";
  space_id: string | null;
  created_at: number;
  payload?: { content: string; tags: string[] };
}

interface IncomingEvent {
  event_id: string;
  memory_id: string;
  event_type: "memory_created" | "memory_forgotten" | "memory_purged";
  space_id: string | null;
  created_at: number;
  payload?: { content: string | null; tags: string[]; purged_at: number | null };
}

function isProSession(deps: MemorySyncDeps): { user: SyncUser; token: string } | null {
  const user = deps.currentUser();
  const token = deps.sessionToken();
  if (!user || !token || user.tier !== "pro") return null;
  // Profile-owner gate: refuses sync when this local profile is bound to
  // a different account. Prevents User B's cloud events from being pulled
  // into User A's local SQLite (Task 4.4).
  if (!deps.profileBinding.isOwnedBy(user.id)) {
    console.warn(
      `[memory] sync blocked — profile is bound to a different account; current=${user.id}, bound=${deps.profileBinding.getBoundOwner()}`,
    );
    return null;
  }
  return { user, token };
}

const BATCH_SIZE = 100;

export function createMemorySyncService(deps: MemorySyncDeps): MemorySyncService {
  return {
    async reconcile() {
      const session = isProSession(deps);
      if (!session) return { pulled: 0, pushed: 0 };
      const pulled = await this.pull();
      const pushed = await this.pushPending();
      return { pulled, pushed };
    },

    async pushPending() {
      const session = isProSession(deps);
      if (!session) return 0;

      type Pending = {
        event_id: string; memory_id: string; event_type: OutgoingEvent["event_type"];
        space_id: string | null; created_at: number;
      };

      // Drain loop: keep flushing batches until no pending events remain
      // for the current owner. Without this, a fresh sign-in with N>BATCH
      // pending events would only push the first batch, then stall until
      // the next reconcile trigger.
      let totalAccepted = 0;
      let conflictPullScheduled = false;
      // Defensive safety cap so a misbehaving server can't loop forever.
      const MAX_BATCHES = 1000;

      for (let i = 0; i < MAX_BATCHES; i++) {
        const pending = deps.db.prepare(
          `SELECT event_id, memory_id, event_type, space_id, created_at
             FROM memory_events
            WHERE cloud_synced_at IS NULL
              AND cloud_owner_id = ?
            ORDER BY created_at ASC
            LIMIT ?`,
        ).all(session.user.id, BATCH_SIZE) as Pending[];

        if (pending.length === 0) break;

        // For created events, fetch content/tags from payloads to attach.
        const payloadStmt = deps.db.prepare(
          `SELECT content, tags FROM memory_payloads WHERE memory_id = ?`,
        );
        const events: OutgoingEvent[] = pending.map((p) => {
          const out: OutgoingEvent = {
            event_id: p.event_id, memory_id: p.memory_id, event_type: p.event_type,
            space_id: p.space_id, created_at: p.created_at,
          };
          if (p.event_type === "memory_created") {
            const pay = payloadStmt.get(p.memory_id) as { content: string | null; tags: string } | undefined;
            if (pay && pay.content !== null) {
              out.payload = { content: pay.content, tags: JSON.parse(pay.tags) };
            }
            // If content is locally NULL (purged before push), the worker
            // accepts the create only if a same-batch or pre-existing purge
            // exists for the memory_id; otherwise it lands in `rejected`.
          }
          return out;
        });

        let res: Response;
        try {
          res = await deps.fetch(`${deps.workerBase}/api/memories/events`, {
            method: "POST",
            headers: { Cookie: `oyster_session=${session.token}`, "content-type": "application/json" },
            body: JSON.stringify({ events }),
          });
        } catch (err) {
          console.warn("[memory] pushPending failed:", err);
          return totalAccepted;
        }
        if (!res.ok) {
          console.warn(`[memory] pushPending non-ok ${res.status}`);
          return totalAccepted;
        }
        const body = await res.json().catch(() => null) as {
          accepted?: string[]; duplicates?: string[]; conflicts?: string[]; rejected?: string[];
        } | null;
        const accepted   = body?.accepted   ?? [];
        const duplicates = body?.duplicates ?? [];
        const conflicts  = body?.conflicts  ?? [];
        const rejected   = body?.rejected   ?? [];

        if (rejected.length > 0) {
          // Surface to logs but do NOT mark synced — these stay pending so a
          // human or follow-up code can investigate. Rejected typically means
          // a malformed event or a memory_created without payload that cloud
          // had no purge for. Should never happen with healthy clients.
          console.warn(`[memory] pushPending rejected events: ${rejected.join(", ")}`);
        }

        if (conflicts.length > 0) {
          // Conflicts mean cloud already has an authoritative event of that
          // type for the memory_id (different event_id). Do NOT blindly mark
          // synced — that risks dropping a legitimate local event with
          // different content (e.g. retry races, deterministic-id bugs).
          // Warn and trigger a pull so cloud's authoritative state lands
          // locally; the next reconcile cycle decides whether the local
          // pending event still has business existing.
          console.warn(
            `[memory] pushPending conflicts (cloud has another event of this type for the memory_id): ${conflicts.join(", ")} — pulling to reconcile`,
          );
          conflictPullScheduled = true;
        }

        // Safe to mark synced: accepted (newly inserted) and duplicates
        // (cloud already had this exact event_id — the round-trip race that
        // Issue 3 covers). Conflicts and rejects stay pending.
        const now = Date.now();
        const markStmt = deps.db.prepare(
          `UPDATE memory_events SET cloud_synced_at = ? WHERE event_id = ?`,
        );
        const markTxn = deps.db.transaction(() => {
          for (const id of accepted)   markStmt.run(now, id);
          for (const id of duplicates) markStmt.run(now, id);
        });
        markTxn();
        totalAccepted += accepted.length;

        // Termination condition: count only "things that cleared from the
        // outbox" as progress. A batch with only conflicts/rejected events
        // breaks out of the drain loop so we don't hot-loop.
        const progress = accepted.length + duplicates.length;
        if (progress === 0) break;
      }

      // If any conflicts surfaced, run a pull so the authoritative cloud
      // state lands locally. The conflicting local events stay pending; the
      // next reconcile cycle will see the now-richer local state and may or
      // may not still have something to push.
      if (conflictPullScheduled) {
        try { await this.pull(); } catch { /* swallowed; logged elsewhere */ }
      }

      return totalAccepted;
    },

    async pull() {
      const session = isProSession(deps);
      if (!session) return 0;

      let res: Response;
      try {
        res = await deps.fetch(`${deps.workerBase}/api/memories/events`, {
          headers: { Cookie: `oyster_session=${session.token}` },
        });
      } catch (err) {
        console.warn("[memory] pull failed:", err);
        return 0;
      }
      if (!res.ok) {
        console.warn(`[memory] pull non-ok ${res.status}`);
        return 0;
      }
      const body = await res.json().catch(() => null) as { events?: IncomingEvent[] } | null;
      const cloud = body?.events ?? [];

      let applied = 0;
      const insertEv = deps.db.prepare(
        // Tag with cloud_owner_id from the current session so the dirty
        // predicate can scope to "this user's events" cleanly. cloud_synced_at
        // is set unconditionally (event came from cloud, definitionally synced).
        `INSERT OR IGNORE INTO memory_events
           (event_id, memory_id, event_type, space_id, cloud_owner_id, created_at, cloud_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      // For events that already exist locally (race: client pushed first then
      // pull saw them in cloud), mark them synced so the outbox stops retrying.
      // Without this, a pending event whose round-trip went out before the
      // push response arrived would stay dirty forever.
      const markSyncedStmt = deps.db.prepare(
        `UPDATE memory_events
            SET cloud_synced_at = COALESCE(cloud_synced_at, ?),
                cloud_owner_id  = COALESCE(cloud_owner_id,  ?)
          WHERE event_id = ?`,
      );
      const upsertPayload = deps.db.prepare(
        `INSERT INTO memory_payloads (memory_id, content, tags, purged_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET
           content   = excluded.content,
           tags      = excluded.tags,
           purged_at = excluded.purged_at`,
      );

      const now = Date.now();
      const txn = deps.db.transaction(() => {
        const touched = new Set<string>();
        for (const ev of cloud) {
          const r = insertEv.run(
            ev.event_id, ev.memory_id, ev.event_type, ev.space_id,
            session.user.id, ev.created_at, now,
          );
          if (r.changes > 0) {
            applied++;
          } else {
            // Event already existed locally — reconcile cloud_synced_at so
            // pushPending stops retrying. COALESCE preserves any earlier
            // sync timestamp.
            markSyncedStmt.run(now, session.user.id, ev.event_id);
          }
          if (ev.event_type === "memory_created" && ev.payload) {
            // Cloud's content reflects redaction. If purged, content is NULL +
            // purged_at set; we mirror that.
            upsertPayload.run(
              ev.memory_id, ev.payload.content, JSON.stringify(ev.payload.tags ?? []), ev.payload.purged_at,
            );
          }
          touched.add(ev.memory_id);
        }
        // Re-materialise affected memory_ids inside the same txn so the FTS5
        // recall surface and the event/payload tables stay atomically consistent.
        for (const id of touched) deps.provider.materialiseMemory(id);
      });
      txn();

      return applied;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/memory-sync-service.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add server/src/memory-sync-service.ts server/test/memory-sync-service.test.ts
git commit -m "feat(server): MemorySyncService with push/pull/reconcile + Pro gate (#318)"
```

---

## Task 9: Wire pushPending into event writes (fire-and-forget)

**Goal:** After every `remember`/`forget`/`purge`, kick a fire-and-forget `pushPending()`. Mirror how `spaceService` calls `pushOne` in spaces sync.

**Files:**
- Modify: `server/src/memory-store.ts` (provider gets an `onWrite` hook)
- Modify: `server/test/memory-store.test.ts`

Approach: the provider exposes a `setOnWrite(cb)` method. `index.ts` wires it to `memorySync.pushPending()` (Task 10). This keeps the provider's surface clean — it doesn't import the sync service — while letting `index.ts` decide what fires when an event is written.

- [ ] **Step 1: Add an `onWrite` hook to the provider**

In `server/src/memory-store.ts`, on `SqliteFtsMemoryProvider`, add an optional callback:

```typescript
export class SqliteFtsMemoryProvider implements MemoryProvider {
  // ... existing fields ...
  private onWrite: (() => void) | null = null;

  /** Register a post-write callback. Called fire-and-forget after each
   *  remember/forget/purge. Intended for the MemorySyncService.pushPending
   *  trigger; sync errors are not propagated back. */
  setOnWrite(cb: () => void): void {
    this.onWrite = cb;
  }
```

In `writeCreated`, `writeForgotten`, `writePurged` (the three methods that produce events), at the end:

```typescript
    // Fire-and-forget. The sync service is responsible for swallowing errors.
    queueMicrotask(() => { try { this.onWrite?.(); } catch { /* swallowed */ } });
```

- [ ] **Step 2: Write a test that the hook fires**

Append to `server/test/memory-store.test.ts`:

```typescript
describe("onWrite hook", () => {
  it("fires after remember", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "onwrite-"));
    const provider = new SqliteFtsMemoryProvider(tmp);
    await provider.init();
    let calls = 0;
    provider.setOnWrite(() => { calls++; });
    await provider.remember({ content: "hi" });
    // queueMicrotask runs after the awaited promise resolves; flush.
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(1);
    provider.close();
  });

  it("fires after forget and purge", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "onwrite-fp-"));
    const provider = new SqliteFtsMemoryProvider(tmp);
    await provider.init();
    let calls = 0;
    provider.setOnWrite(() => { calls++; });
    const m = await provider.remember({ content: "x" });
    await new Promise((r) => setImmediate(r));
    await provider.forget(m.id);
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(2);
    await provider.purge(m.id);
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(3);
    provider.close();
  });
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd server && npx vitest run test/memory-store.test.ts -t "onWrite"`
Expected: 2 passing.

- [ ] **Step 4: Commit**

```bash
git add server/src/memory-store.ts server/test/memory-store.test.ts
git commit -m "feat(memory): onWrite hook for fire-and-forget sync trigger (#318)"
```

---

## Task 10: Wire `reconcile` into auth/startup; wire `pushPending` to provider hook

**Goal:** Construct `MemorySyncService` in `server/src/index.ts` next to `spaceSync`. Run `reconcile()` on sign-in and at app start. Wire `provider.setOnWrite(() => memorySync.pushPending())` so each event write fires a push.

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: Find the spaces-sync wiring as a reference**

The relevant block in `server/src/index.ts` (around line 290–370) constructs `spaceSync`, registers `authService.onAuthChanged`, calls `syncOnAuth("startup")`. Mirror this for memory.

- [ ] **Step 2: Add the imports + construction**

In `server/src/index.ts`, near the top with other service imports:

```typescript
import { createMemorySyncService, type MemorySyncService } from "./memory-sync-service.js";
```

First, expose the DB handle on the provider. In `server/src/memory-store.ts`, on `SqliteFtsMemoryProvider`. The name is deliberately ugly to signal "do not use casually outside the sync service":

```typescript
  /** Internal DB handle for the sync service ONLY. Do not use elsewhere —
   *  sync needs it for batched outbox queries; everything else should go
   *  through the provider's typed methods. */
  getInternalDbForSync(): Database.Database { return this.db; }
```

Then, where `spaceSync` is constructed (search for `createSpaceSyncService(`), add immediately after:

```typescript
const memorySync: MemorySyncService = createMemorySyncService({
  db: memoryProvider.getInternalDbForSync(),
  provider: memoryProvider,
  profileBinding,                           // constructed in Task 4.4
  currentUser: () => {
    const u = authService.getState().user;
    return u ? { id: u.id, email: u.email, tier: u.tier } : null;
  },
  sessionToken: () => authService.getState().sessionToken,
  workerBase: CLOUD_WORKER_BASE,
  fetch: globalThis.fetch,
});
memoryProvider.setOnWrite(() => { void memorySync.pushPending(); });
```

- [ ] **Step 3: Wire reconcile into the existing sync-on-auth function — and gate every cloud sync service on `canRunCloudSync()`**

Find `syncOnAuth(reason: "auth" | "startup")` (around line 346 in spaces-sync wiring). Make two changes:

1. **Early-return on profile-binding conflict**, gating EVERY cloud sync service. Belt-and-braces alongside the per-service `isProSession` check that Task 4.4 step 7 added inside `space-sync-service.ts` — the orchestration-layer guard means we don't accidentally call into reconcile/pull paths at all when the profile is conflicted.
2. Add the memory reconcile call alongside the spaces one.

```typescript
async function syncOnAuth(reason: "auth" | "startup"): Promise<void> {
  // Single chokepoint. If the profile is bound to a different Pro account
  // (or the user is free / signed-out), skip ALL cloud sync — spaces,
  // memory, anything else. Without this guard, existing spaces sync would
  // continue to run and pollute the local DB with a second user's data.
  if (!canRunCloudSync()) return;

  try {
    const result = await spaceSync.reconcile();
    if (result.pulled || result.pushed || result.tombstoned) {
      // ... existing broadcast ...
    }
    const memResult = await memorySync.reconcile();
    if (memResult.pulled || memResult.pushed) {
      console.log(`[memory] reconcile (${reason}): pulled=${memResult.pulled} pushed=${memResult.pushed}`);
    }
  } catch (err) {
    console.warn(`[sync] reconcile (${reason}) failed:`, err);
  }
  // ... existing publishService.backfillPublications() ...
}
```

Both reconcile paths AND the mutation-triggered `spaceSync.pushOne(...)` / `spaceSync.pushDelete(...)` calls are protected: Task 4.4 step 7 adds `profileBinding.isOwnedBy()` to `space-sync-service.ts`'s own `isProSession` helper, so every entry point on both sync services returns no-op on a conflicted profile. There is no residual exposure to call out here.

- [ ] **Step 4: Smoke-build the server**

Run: `cd server && npm run build`
Expected: TypeScript compiles cleanly. No new errors.

- [ ] **Step 5: Run the full server test suite**

Run: `cd server && npx vitest run`
Expected: all passing.

- [ ] **Step 6: Manual smoke — `npm run dev` and verify boot**

Run from repo root: `npm run dev`
Expected: server starts on :3333; logs show no memory-sync errors. With a Pro account signed in (or simulated in dev), creating a memory should produce a `[memory]` log line on the next event flush.

- [ ] **Step 7: Commit**

```bash
git add server/src/index.ts server/src/memory-store.ts
git commit -m "feat(server): wire memory sync into auth + startup hooks (#318)"
```

---

## Task 11: Manual cross-device verification

**Goal:** Confirm the architectural promise on real hardware. Six flows; any failure blocks merge.

**Setup:**
- Two machines, both signed in to the same Pro account.
- Machine A: this dev branch.
- Machine B: same branch, separate worktree or device.

- [ ] **Step 1: Flow 1 — basic propagation**

  - On A: `remember(content="cross-device test 1")`
  - On B: trigger reconcile (sign-out + sign-in, or restart server)
  - Expected: `recall("cross-device")` on B returns the memory.

- [ ] **Step 2: Flow 2 — forget propagation**

  - On A: `forget(memory_id)`
  - On B: reconcile
  - Expected: `recall("cross-device")` returns nothing on either machine.

- [ ] **Step 3: Flow 3 — purge redaction**

  - On A: create a memory containing a fake "secret-key-AKIA9999"
  - On A: trigger purge via internal method (e.g. test endpoint or REPL)
  - On B: reconcile
  - Expected: D1 `synced_memory_payloads.content` is NULL for that `memory_id`. Local `memories` row has no entry. No FTS5 hit anywhere.

- [ ] **Step 4: Flow 4 — out-of-order delivery**

  - On A (offline): create memory, then immediately purge it. Both events queued in outbox.
  - On A (online): reconnect; flush. Verify both events sent.
  - Tear down A's local DB to simulate fresh device. Sign in again.
  - Expected: pull on A receives create + purge. Materialised state: no recall hit, content NULL in cloud.

- [ ] **Step 5: Flow 5 — free user does not sync**

  - Switch account to free tier (or use a separate free-tier test user).
  - On A: `remember(content="free-tier test")`
  - Expected: no Worker calls; events pile up locally with `cloud_synced_at IS NULL`. No errors. Local recall still works.

- [ ] **Step 6: Flow 6 — fresh Pro sign-in on a clean device backfills cloud memories**

  - On a third machine C with no prior Oyster install (or after deleting `~/Oyster/db/memory.db`): install, sign in to the same Pro account.
  - Expected: reconcile pulls all of A and B's events; recall on C returns memories created on A or B, including those from earlier flows. Forgotten memories don't appear; purged content has no recall hit.
  - Validate: `SELECT COUNT(*) FROM memory_events` on C matches the cloud event count for that user.

- [ ] **Step 7: If all six flows pass — record the verification**

In a comment on PR for #318: "Manual cross-device verified on 2026-MM-DD. Six flows green."

If any flow fails: open a follow-up issue; do not merge until resolved or explicitly deferred to hotfix.

- [ ] **Step 8: Commit (no code; this is a verification step)**

No commit needed unless flows surfaced bugs. If they did, fix in a follow-up task within the same plan and re-run all six flows.

---

## Task 12: CHANGELOG entry

**Goal:** User-visible outcome line for `CHANGELOG.md`.

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add entry under [Unreleased] → Added**

In the appropriate section (`Unreleased` if it exists, else create one):

```markdown
### Added
- **Memories follow you across Pro devices.** Anything you remember on one Pro device shows up on every other Pro device signed into the same account. Forgetting and deletion propagate too. Only memories created while signed into your bound Pro profile sync — pre-existing local memories and anything created on a free account stay local.
```

- [ ] **Step 2: Regenerate `docs/changelog.html`**

Run: `npm run build:changelog`
Expected: `docs/changelog.html` updated.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md docs/changelog.html
git commit -m "docs(changelog): cross-device memory sync (#318)"
```

---

## Self-Review Checklist (run before opening PR)

- [ ] All 14 tasks completed (1–4, 4.4, 4.5, 5–12); each commit message references #318
- [ ] No `TODO` / `TBD` / placeholder strings in committed code
- [ ] `npm run build` succeeds at repo root
- [ ] `cd server && npx vitest run` — all pass
- [ ] `cd infra/oyster-cloud && npx vitest run` — all pass
- [ ] `cd infra/oyster-publish && npx vitest run` — still passes (no regressions from oyster-cloud bootstrap)
- [ ] Manual cross-device verification (Task 11, six flows) recorded in PR
- [ ] CHANGELOG entry is user-facing (no internal file paths, route names, or tool names)
- [ ] Worker-side Pro tier gate active (POST and GET both check `user.tier === "pro"`)
- [ ] Per-type uniqueness indexes present in both local + cloud schemas
- [ ] `event_type` CHECK constraint present in both local + cloud schemas
- [ ] Purge precedence verified with a test (late-create-after-purge in both local and worker)
- [ ] `cloud_owner_id` set at write time on every event; `pushPending` filters strictly
- [ ] **`profile_binding` table exists; `bindToOwner` runs on first Pro sign-in; `isProSession` checks `isOwnedBy`**
- [ ] **`canRunCloudSync()` is the single chokepoint — `syncOnAuth` early-returns on conflict, blocking spaces sync AND memory sync (and any future cloud sync) at the orchestration layer**
- [ ] **Both `MemorySyncService.isProSession` AND `SpaceSyncService.isProSession` check `profileBinding.isOwnedBy()` — so mutation-triggered `pushOne`/`pushDelete`/`pushPending` are also blocked on a conflicted profile, not just reconcile**
- [ ] **Test: a different Pro user signing into a bound profile is blocked from memory sync (no fetch calls)**
- [ ] **Test: a different Pro user signing into a bound profile is blocked from spaces sync — `reconcile`, `pushOne`, AND `pushDelete` all no-op without fetch calls**
- [ ] **Manual: confirm that on a profile-conflicted sign-in, neither `[memory]` nor `[spaces]` sync log lines appear during reconcile, AND that creating/renaming a space on the conflicted profile produces no Worker calls**
- [ ] **`resolveCurrentOwnerId` returns null for free / signed-out users — only Pro accounts tag events**
- [ ] Worker POST response shape is `{ accepted, duplicates, conflicts, rejected }` — `rejected` not marked synced by client
- [ ] **`conflicts` are warned-and-pulled, NOT marked synced — only `accepted` and `duplicates` clear from outbox**
- [ ] `pushPending` drains all batches (not just one) before returning
- [ ] Pull marks local pending events as synced when matched in cloud (round-trip race test)
- [ ] Worker POST sorts events by precedence (purges first) before per-event processing
- [ ] `memory_created` without payload is rejected unless a purge already exists for that memory_id

## Out of scope for this plan (per spec §"Deferred to the implementation plan")

The following are intentionally NOT in this plan and remain follow-ups:

- First-sync UX polish (loading indicators, skeleton states for the inspector during initial pull) — v1 is non-blocking by default; recall returns partial during pull.
- MCP tool surface for `purge` — server-internal only in v1.
- Inspector / settings UI for managing synced memories.
- Quotas / retention policy for the cloud event log.
- Worker-side rate limiting on `/api/memories/events` (basic Pro gate is in place).
- Account-deletion flow (purges all events + payloads for an `owner_id`) — needs a separate spec for the cross-system deletion path.
- Backfill performance for users with very large memory stores (>10k rows) — backfill is synchronous at boot today; if it becomes slow, defer to a background pass with a "syncing memories…" indicator.
- **UI surface for profile-binding conflicts.** Today the conflict path only logs. A user signing into a different Pro account on the same machine sees no error explaining why sync silently isn't working. A follow-up should add a clear UI message + a "reset profile" affordance.
- **"Claim local memories for this Pro account" flow.** Pre-Pro / pre-binding memories stay local in v1. A future plan can add an opt-in claim that promotes them into the bound Pro account.

These should land as separate plans or PRs once #318 is merged and the cross-device promise is proven.
