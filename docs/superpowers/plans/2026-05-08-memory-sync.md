# Memory Sync Implementation Plan (#318)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cross-device sync for the Oyster memory store. A memory created on one Pro device must propagate to all other Pro devices owned by the same user, with deterministic precedence on forget and purge.

**Architecture:** Append-only event log (`memory_events`) paired with a redactable content store (`memory_payloads`), both mirrored on Cloudflare D1. The local SQLite `memories` table remains the FTS5 recall surface, materialised from events + payloads using the precedence rule **purged > forgotten > created**. No row sync, no LWW, no vector clocks, no merge function. Outbox flush is fire-and-forget per event after each `remember`/`forget`/`purge`; reconcile (full pull) runs on auth-changed and at app start. Pro-only.

**Tech Stack:** TypeScript, better-sqlite3 (local), Cloudflare D1 + Workers (cloud), vitest, @cloudflare/vitest-pool-workers.

**Spec:** `docs/superpowers/specs/2026-05-08-memory-sync-design.md`

**Worktree:** Per `feedback_worktree_location.md`, isolate this feature in `~/Dev/oyster-os.worktrees/memory-sync/`. Branch from `main` as `feat/memory-sync-318`.

**Pattern reference:** `server/src/space-sync-service.ts` and `infra/oyster-publish/src/worker.ts` lines 334–492 are the closest cousin. Memory sync mirrors the auth wiring and Pro-gate machinery but replaces LWW row sync with idempotent event ingestion and precedence-based materialisation.

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
    expect(names).toEqual(["cloud_synced_at", "created_at", "event_id", "event_type", "memory_id", "space_id"]);
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_events (
        event_id        TEXT    PRIMARY KEY,
        memory_id       TEXT    NOT NULL,
        event_type      TEXT    NOT NULL,
        space_id        TEXT,
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
writeCreated(input: { memory_id?: string; content: string; space_id?: string|null; tags?: string[]; source_session_id?: string|null; created_at?: number }): { memory_id: string; event_id: string };
writeForgotten(memory_id: string): boolean;  // false if no row
writePurged(memory_id: string): boolean;     // false if no row in events
materialiseMemory(memory_id: string): void;  // (re)derive memories row from events+payloads using precedence
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
  }): { memory_id: string; event_id: string } {
    const memory_id = input.memory_id ?? crypto.randomUUID();
    const event_id  = crypto.randomUUID();
    const space_id  = input.space_id ?? null;
    const tags      = JSON.stringify(input.tags ?? []);
    const ssid      = input.source_session_id ?? null;
    const created_at = input.created_at ?? Date.now();

    const txn = this.db.transaction(() => {
      this.db.prepare(
        `INSERT OR IGNORE INTO memory_events
           (event_id, memory_id, event_type, space_id, created_at, cloud_synced_at)
         VALUES (?, ?, 'memory_created', ?, ?, NULL)`,
      ).run(event_id, memory_id, space_id, created_at);

      this.db.prepare(
        `INSERT OR IGNORE INTO memory_payloads (memory_id, content, tags)
         VALUES (?, ?, ?)`,
      ).run(memory_id, input.content, tags);

      this.materialiseMemory(memory_id, { ssid });
    });
    txn();
    return { memory_id, event_id };
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
  writeForgotten(memory_id: string): boolean {
    // Idempotent: per-type uniqueness means a second forget event is rejected.
    const info = this.db.prepare(
      `INSERT OR IGNORE INTO memory_events
         (event_id, memory_id, event_type, space_id, created_at, cloud_synced_at)
       VALUES (?, ?, 'memory_forgotten', NULL, ?, NULL)`,
    ).run(crypto.randomUUID(), memory_id, Date.now());
    if (info.changes === 0) return false;
    this.materialiseMemory(memory_id);
    return true;
  }

  writePurged(memory_id: string): boolean {
    const info = this.db.prepare(
      `INSERT OR IGNORE INTO memory_events
         (event_id, memory_id, event_type, space_id, created_at, cloud_synced_at)
       VALUES (?, ?, 'memory_purged', NULL, ?, NULL)`,
    ).run(crypto.randomUUID(), memory_id, Date.now());
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

**Goal:** Existing MCP/HTTP entry points (`remember`, `forget`) now go through the event API. Add a server-internal `purge(id)` method on the provider — not exposed via MCP yet (per spec: "Possibly not exposed via MCP at all in the first cut").

**Files:**
- Modify: `server/src/memory-store.ts` (rewrite `remember` / `forget` bodies; add `purge` to interface + impl)
- Modify: `server/test/memory-store.test.ts` (existing tests still pass; add one for `purge`)

- [ ] **Step 1: Migrate `remember()` body**

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
    });
    const row = this.stmts.getById.get(memory_id) as MemoryRow;
    return rowToMemory(row);
  }
```

- [ ] **Step 2: Migrate `forget()` body**

Replace the `async forget(id)` method body:

```typescript
  async forget(id: string): Promise<boolean> {
    const row = this.stmts.getById.get(id) as MemoryRow | undefined;
    if (!row) return false;
    this.writeForgotten(id);
    return true;
  }
```

- [ ] **Step 3: Add `purge` to the `MemoryProvider` interface**

In the `MemoryProvider` interface (top of file), add:

```typescript
  /** Server-internal hard-redaction. Writes a purge event and nulls payload
   *  content. Not exposed via MCP in v1; reserved for "delete forever" UI,
   *  account deletion, and secret-exposure flows. */
  purge(id: string): Promise<boolean>;
```

- [ ] **Step 4: Implement `purge` on the provider**

After `forget`:

```typescript
  async purge(id: string): Promise<boolean> {
    const row = this.stmts.getById.get(id) as MemoryRow | undefined;
    const hasEvent = this.db.prepare(
      `SELECT 1 FROM memory_events WHERE memory_id = ? LIMIT 1`,
    ).get(id);
    if (!row && !hasEvent) return false;
    this.writePurged(id);
    return true;
  }
```

- [ ] **Step 5: Write a test for `purge`**

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

- [ ] **Step 6: Run the full memory-store suite**

Run: `cd server && npx vitest run test/memory-store.test.ts`
Expected: all passing — existing `remember`/`forget` tests still pass because the surface contract is unchanged.

- [ ] **Step 7: Run the full server test suite to catch downstream breakage**

Run: `cd server && npx vitest run`
Expected: all passing. If `routes/memories.ts` or `mcp-server.ts` tests fail, debug — the surface should be unchanged.

- [ ] **Step 8: Commit**

```bash
git add server/src/memory-store.ts server/test/memory-store.test.ts
git commit -m "feat(memory): route remember/forget through event API; add internal purge (#318)"
```

---

## Task 4: Backfill existing memories at boot

**Goal:** On server start, any existing `memories` rows that have no corresponding `memory_created` event get one inserted (with the original `created_at`). If `superseded_by` is non-NULL, also insert a `memory_forgotten` event. Idempotent — re-running is a no-op due to the per-type unique indexes.

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
      this.db.prepare(
        `INSERT OR IGNORE INTO memory_events
           (event_id, memory_id, event_type, space_id, created_at, cloud_synced_at)
         VALUES (?, ?, 'memory_created', ?, ?, NULL)`,
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
             (event_id, memory_id, event_type, space_id, created_at, cloud_synced_at)
           VALUES (?, ?, ?, NULL, ?, NULL)`,
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

## Task 5: Cloud D1 migration — synced_memory_events + synced_memory_payloads

**Goal:** Mirror the local schema in D1 with all four uniqueness constraints from the spec.

**Files:**
- Create: `infra/auth-worker/migrations/0007_synced_memories.sql`
- Modify: `infra/oyster-publish/test/spaces.test.ts` (or new test file) — verify migration applies.

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
  event_type      TEXT    NOT NULL,    -- memory_created | memory_forgotten | memory_purged
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

Worker tests run with `@cloudflare/vitest-pool-workers`. Migrations are applied via `wrangler d1 migrations apply --local` before the suite runs (or via the project's existing test setup — check `infra/oyster-publish/vitest.config.ts` and the corresponding `setup` file used by spaces tests; mirror its migration-loading mechanism). Create a new file `infra/oyster-publish/test/memories-events.test.ts`:

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

Run: `cd infra/oyster-publish && npx vitest run test/memories-events.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add infra/auth-worker/migrations/0007_synced_memories.sql infra/oyster-publish/test/memories-events.test.ts
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
{ "accepted": ["event_id1", "event_id2"], "skipped": ["event_id3"] }
```

`skipped` covers duplicates (event_id already exists) and idempotent-uniqueness conflicts (e.g. second create for same memory_id).

**Files:**
- Modify: `infra/oyster-publish/src/worker.ts` (route handler + dispatch)
- Modify: `infra/oyster-publish/test/memories-events.test.ts`

- [ ] **Step 1: Wire the route in the dispatcher**

In `infra/oyster-publish/src/worker.ts`, in the main `fetch` block (around line 89, before the final `return new Response("Not Found", ...)`):

```typescript
    if (url.pathname === "/api/memories/events" && req.method === "POST") {
      return handleMemoryEventsPost(req, env);
    }
    if (url.pathname === "/api/memories/events" && req.method === "GET") {
      return handleMemoryEventsGet(req, env, url);
    }
```

- [ ] **Step 2: Write failing tests for POST**

Append to `infra/oyster-publish/test/memories-events.test.ts`:

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
    const body = await res.json() as { accepted: string[]; skipped: string[] };
    expect(body.accepted).toEqual(["ev-1"]);
    expect(body.skipped).toEqual([]);

    const ev = await env.DB.prepare(
      `SELECT event_type FROM synced_memory_events WHERE owner_id = ? AND event_id = ?`,
    ).bind(userId, "ev-1").first<{ event_type: string }>();
    expect(ev?.event_type).toBe("memory_created");

    const pay = await env.DB.prepare(
      `SELECT content FROM synced_memory_payloads WHERE owner_id = ? AND memory_id = ?`,
    ).bind(userId, "mem-1").first<{ content: string }>();
    expect(pay?.content).toBe("hello");
  });

  it("is idempotent on duplicate event_id (skipped)", async () => {
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
    expect((await second.json() as any).skipped).toEqual(["ev-dup"]);
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

Run: `cd infra/oyster-publish && npx vitest run test/memories-events.test.ts -t "POST"`
Expected: 5 failures — handlers don't exist.

- [ ] **Step 4: Implement `handleMemoryEventsPost`**

In `infra/oyster-publish/src/worker.ts`, after `handleSpacesDelete`:

```typescript
async function handleMemoryEventsPost(req: Request, env: Env): Promise<Response> {
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

  const events = body.events ?? [];
  if (!Array.isArray(events)) return jsonError(400, "invalid_metadata");

  const accepted: string[] = [];
  const skipped: string[] = [];
  const now = Date.now();

  for (const ev of events) {
    if (
      typeof ev.event_id !== "string" ||
      typeof ev.memory_id !== "string" ||
      (ev.event_type !== "memory_created" && ev.event_type !== "memory_forgotten" && ev.event_type !== "memory_purged") ||
      typeof ev.created_at !== "number"
    ) {
      skipped.push(ev.event_id ?? "<malformed>");
      continue;
    }

    // Insert event with INSERT OR IGNORE on (owner_id, event_id) PK and the
    // per-type unique indexes. Either succeeds (accepted) or no-ops (skipped).
    const evResult = await env.DB.prepare(
      `INSERT OR IGNORE INTO synced_memory_events
         (owner_id, event_id, memory_id, event_type, space_id, created_at, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(user.id, ev.event_id, ev.memory_id, ev.event_type, ev.space_id, ev.created_at, now).run();

    if (!evResult.meta.changes) {
      skipped.push(ev.event_id);
      continue;
    }
    accepted.push(ev.event_id);

    // Apply payload-side effects with the precedence rule:
    //   purge dominates → if any purge exists for this memory_id, content=NULL.
    //   create with content → only set content/tags if no purge yet.
    //   forgotten → no payload change.
    if (ev.event_type === "memory_purged") {
      await env.DB.prepare(
        `INSERT INTO synced_memory_payloads (owner_id, memory_id, content, tags, purged_at)
         VALUES (?, ?, NULL, '[]', ?)
         ON CONFLICT(owner_id, memory_id) DO UPDATE SET
           content   = NULL,
           tags      = '[]',
           purged_at = excluded.purged_at`,
      ).bind(user.id, ev.memory_id, ev.created_at).run();
    } else if (ev.event_type === "memory_created" && ev.payload) {
      // Idempotent payload upsert that respects an earlier purge.
      // Insert content only if no purge exists; otherwise leave content NULL.
      await env.DB.prepare(
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
      ).bind(user.id, ev.memory_id, ev.payload.content, JSON.stringify(ev.payload.tags), user.id, ev.memory_id).run();
    }
  }

  return jsonOk({ accepted, skipped });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd infra/oyster-publish && npx vitest run test/memories-events.test.ts -t "POST"`
Expected: 5 passing.

- [ ] **Step 6: Commit**

```bash
git add infra/oyster-publish/src/worker.ts infra/oyster-publish/test/memories-events.test.ts
git commit -m "feat(worker): POST /api/memories/events with idempotent ingest + Pro gate (#318)"
```

---

## Task 7: Worker route GET /api/memories/events

**Goal:** Pull all events for the signed-in Pro user, joined with payload state, ordered by `created_at`. No pagination in v1 — memories are tiny; full mirror per device is the design.

**Files:**
- Modify: `infra/oyster-publish/src/worker.ts`
- Modify: `infra/oyster-publish/test/memories-events.test.ts`

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

Append to `infra/oyster-publish/test/memories-events.test.ts`:

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

Run: `cd infra/oyster-publish && npx vitest run test/memories-events.test.ts -t "GET"`
Expected: 3 failures.

- [ ] **Step 3: Implement `handleMemoryEventsGet`**

In `worker.ts`, after `handleMemoryEventsPost`:

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

Run: `cd infra/oyster-publish && npx vitest run test/memories-events.test.ts -t "GET"`
Expected: 3 passing.

- [ ] **Step 5: Run full worker test suite to confirm no regressions**

Run: `cd infra/oyster-publish && npx vitest run`
Expected: all passing (existing space + publish tests still pass).

- [ ] **Step 6: Commit**

```bash
git add infra/oyster-publish/src/worker.ts infra/oyster-publish/test/memories-events.test.ts
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

function harness() {
  const tmp = mkdtempSync(join(tmpdir(), "memsync-"));
  const provider = new SqliteFtsMemoryProvider(tmp);
  return { tmp, provider };
}

describe("MemorySyncService", () => {
  it("reconcile is a no-op for free users", async () => {
    const { provider } = harness();
    await provider.init();
    const fetchSpy = vi.fn();
    const svc = createMemorySyncService({
      db: (provider as any).db,
      provider,
      currentUser: () => ({ id: "u1", email: "x@x", tier: "free" }),
      sessionToken: () => "tok",
      workerBase: "https://example.com",
      fetch: fetchSpy,
    });
    const r = await svc.reconcile();
    expect(r).toEqual({ pulled: 0, pushed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("pushPending sends pending events and marks them synced", async () => {
    const { provider } = harness();
    await provider.init();
    const m = await provider.remember({ content: "hello" });

    const fetchSpy = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ accepted: [], skipped: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    // Mock: server accepts whatever event_ids we send.
    fetchSpy.mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { events: Array<{ event_id: string }> };
      return new Response(
        JSON.stringify({ accepted: body.events.map((e) => e.event_id), skipped: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const svc = createMemorySyncService({
      db: (provider as any).db,
      provider,
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
    const { provider } = harness();
    await provider.init();

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

  it("pull respects purge precedence — late create does not restore content", async () => {
    const { provider } = harness();
    await provider.init();

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
    const { provider } = harness();
    await provider.init();
    await provider.remember({ content: "stays-dirty" });

    const fetchSpy = vi.fn().mockRejectedValue(new TypeError("network"));
    const svc = createMemorySyncService({
      db: (provider as any).db,
      provider,
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

interface SyncUser { id: string; email: string; tier: string }

export interface MemorySyncDeps {
  db: Database.Database;
  provider: SqliteFtsMemoryProvider;
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
      const pending = deps.db.prepare(
        `SELECT event_id, memory_id, event_type, space_id, created_at
           FROM memory_events
          WHERE cloud_synced_at IS NULL
          ORDER BY created_at ASC
          LIMIT ?`,
      ).all(BATCH_SIZE) as Pending[];

      if (pending.length === 0) return 0;

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
        return 0;
      }
      if (!res.ok) {
        console.warn(`[memory] pushPending non-ok ${res.status}`);
        return 0;
      }
      const body = await res.json().catch(() => null) as { accepted?: string[]; skipped?: string[] } | null;
      const accepted = new Set(body?.accepted ?? []);
      const skipped  = new Set(body?.skipped ?? []);

      // Mark accepted AND skipped as synced — skipped means the cloud already
      // has them (duplicate event_id or per-type uniqueness conflict). Either
      // way, the local outbox can stop retrying.
      const now = Date.now();
      const markStmt = deps.db.prepare(
        `UPDATE memory_events SET cloud_synced_at = ? WHERE event_id = ?`,
      );
      const markTxn = deps.db.transaction(() => {
        for (const id of accepted) markStmt.run(now, id);
        for (const id of skipped)  markStmt.run(now, id);
      });
      markTxn();
      return accepted.size;
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
        `INSERT OR IGNORE INTO memory_events
           (event_id, memory_id, event_type, space_id, created_at, cloud_synced_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
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
          const r = insertEv.run(ev.event_id, ev.memory_id, ev.event_type, ev.space_id, ev.created_at, now);
          if (r.changes > 0) applied++;
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

First, expose the DB handle on the provider. In `server/src/memory-store.ts`, on `SqliteFtsMemoryProvider`:

```typescript
  getDb(): Database.Database { return this.db; }
```

Then, where `spaceSync` is constructed (search for `createSpaceSyncService(`), add immediately after:

```typescript
const memorySync: MemorySyncService = createMemorySyncService({
  db: memoryProvider.getDb(),
  provider: memoryProvider,
  currentUser: () => {
    const u = authService.getState().user;
    return u ? { id: u.id, email: u.email, tier: u.tier } : null;
  },
  sessionToken: () => authService.getState().sessionToken,
  workerBase: WORKER_BASE,
  fetch: globalThis.fetch,
});
memoryProvider.setOnWrite(() => { void memorySync.pushPending(); });
```

- [ ] **Step 3: Wire reconcile into the existing sync-on-auth function**

Find `syncOnAuth(reason: "auth" | "startup")` (around line 346 in spaces-sync wiring). Add a memory reconcile call alongside the spaces one:

```typescript
async function syncOnAuth(reason: "auth" | "startup"): Promise<void> {
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

**Goal:** Confirm the architectural promise on real hardware. Five flows; any failure blocks merge.

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

- [ ] **Step 6: If all five flows pass — record the verification**

In a comment on PR for #318: "Manual cross-device verified on 2026-MM-DD. Five flows green."

If any flow fails: open a follow-up issue; do not merge until resolved or explicitly deferred to hotfix.

- [ ] **Step 7: Commit (no code; this is a verification step)**

No commit needed unless flows surfaced bugs. If they did, fix in a follow-up task within the same plan and re-run all five flows.

---

## Task 12: CHANGELOG entry

**Goal:** User-visible outcome line for `CHANGELOG.md`.

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add entry under [Unreleased] → Added**

In the appropriate section (`Unreleased` if it exists, else create one):

```markdown
### Added
- **Memories follow you across devices.** Anything you remember on one Pro device shows up on every other Pro device signed into the same account. Forgetting and deletion propagate too. Free accounts are unaffected — memories stay local.
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

- [ ] All 12 tasks completed; each commit message references #318
- [ ] No `TODO` / `TBD` / placeholder strings in committed code
- [ ] `npm run build` succeeds at repo root
- [ ] `cd server && npx vitest run` — all pass
- [ ] `cd infra/oyster-publish && npx vitest run` — all pass
- [ ] Manual cross-device verification (Task 11) recorded in PR
- [ ] CHANGELOG entry is user-facing (no internal file paths, route names, or tool names)
- [ ] Worker-side Pro tier gate active (POST and GET both check `user.tier === "pro"`)
- [ ] Per-type uniqueness indexes present in both local + cloud schemas
- [ ] Purge precedence verified with a test (late-create-after-purge)

## Out of scope for this plan (per spec §"Deferred to the implementation plan")

The following are intentionally NOT in this plan and remain follow-ups:

- First-sync UX polish (loading indicators, skeleton states for the inspector during initial pull) — v1 is non-blocking by default; recall returns partial during pull.
- MCP tool surface for `purge` — server-internal only in v1.
- Inspector / settings UI for managing synced memories.
- Quotas / retention policy for the cloud event log.
- Worker-side rate limiting on `/api/memories/events` (basic Pro gate is in place).
- Account-deletion flow (purges all events + payloads for an `owner_id`) — needs a separate spec for the cross-system deletion path.
- Backfill performance for users with very large memory stores (>10k rows) — backfill is synchronous at boot today; if it becomes slow, defer to a background pass with a "syncing memories…" indicator.

These should land as separate plans or PRs once #318 is merged and the cross-device promise is proven.
