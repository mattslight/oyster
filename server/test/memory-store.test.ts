import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteFtsMemoryProvider } from "../src/memory-store.js";

// SqliteFtsMemoryProvider does its own schema/migrations on init().
// We just hand it a fresh tmp dir per test.
async function makeProvider() {
  const dir = mkdtempSync(join(tmpdir(), "oyster-memory-test-"));
  const provider = new SqliteFtsMemoryProvider(dir);
  await provider.init();
  return { provider, dir };
}

// Shared tmpdir tracker for new describe blocks. afterEach below cleans all
// entries so new tests never leak temp dirs.
const trackedTmps: string[] = [];
function tmp(prefix: string): string {
  const t = mkdtempSync(join(tmpdir(), prefix));
  trackedTmps.push(t);
  return t;
}

afterEach(() => {
  while (trackedTmps.length > 0) {
    const t = trackedTmps.pop()!;
    try { rmSync(t, { recursive: true, force: true }); } catch { /* swallow */ }
  }
});

describe("SqliteFtsMemoryProvider", () => {
  let provider: SqliteFtsMemoryProvider;
  let dir: string;

  beforeEach(async () => {
    ({ provider, dir } = await makeProvider());
  });

  afterEach(() => {
    // Close the SQLite handle first so the WAL/shm files can be removed —
    // matters on Windows where unlink fails while the connection is open.
    provider?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  describe("remember", () => {
    it("returns the existing row when same content + same space is remembered twice", async () => {
      const a = await provider.remember({ content: "matt likes coffee", space_id: "home" });
      const b = await provider.remember({ content: "matt likes coffee", space_id: "home" });
      expect(b.id).toBe(a.id);
    });

    it("returns the existing row when content matches and both are global (NULL space)", async () => {
      const a = await provider.remember({ content: "global fact" });
      const b = await provider.remember({ content: "global fact" });
      expect(b.id).toBe(a.id);
    });

    it("creates a new row when same content lands in different spaces", async () => {
      const a = await provider.remember({ content: "duplicate", space_id: "home" });
      const b = await provider.remember({ content: "duplicate", space_id: "work" });
      expect(b.id).not.toBe(a.id);
    });

    it("persists tags as an array", async () => {
      const m = await provider.remember({ content: "tagged", tags: ["preference", "work"] });
      expect(m.tags).toEqual(["preference", "work"]);
    });

    it("persists source_session_id when provided", async () => {
      const m = await provider.remember({ content: "from-session", source_session_id: "sess_abc" });
      const written = await provider.getBySourceSession("sess_abc");
      expect(written).toHaveLength(1);
      expect(written[0].id).toBe(m.id);
    });

    it("returns created_at as an unambiguous UTC ISO-8601 string", async () => {
      // SQLite's datetime('now') yields "YYYY-MM-DD HH:MM:SS" (UTC, no zone
      // marker). JS Date.parse() of that string is treated as local time —
      // so a Dubai (UTC+4) browser shows a 4-hour skew. The provider must
      // return strict ISO-8601 with a T separator and a Z (or ±HH:MM) marker.
      const before = Date.now();
      const m = await provider.remember({ content: "timestamp-shape" });
      const after = Date.now();
      // Strict ISO-8601 datetime: YYYY-MM-DDThh:mm:ss[.sss](Z|±HH:MM)
      expect(m.created_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
      );
      // Must round-trip via Date to a moment within the call window
      // (allow 5s slack for slow CI).
      const parsed = Date.parse(m.created_at);
      expect(Number.isNaN(parsed)).toBe(false);
      expect(parsed).toBeGreaterThanOrEqual(before - 5_000);
      expect(parsed).toBeLessThanOrEqual(after + 5_000);
    });

    it("importMemories canonicalises created_at to the SQLite text form", async () => {
      // Read-side normalisation alone leaves a seam: exportMemories emits ISO
      // strings, but importMemories used to insert them verbatim into a column
      // that organic writes fill with `YYYY-MM-DD HH:MM:SS`. SQLite ORDER BY
      // is lexicographic, so mixed forms reorder rows incorrectly (T > space
      // in ASCII, so all imported rows sort after all organic rows regardless
      // of when they were created). Inserts must canonicalise to keep the DB
      // column uniform.
      await provider.importMemories([
        {
          id: "imp-iso",
          content: "imported with iso form",
          space_id: null,
          tags: [],
          created_at: "2026-01-15T10:30:00.000Z",
          source_session_id: null,
        },
      ]);
      // Inspect the raw DB column directly — must be the SQLite space-form,
      // not the ISO form passed in.
      const db = (provider as unknown as { db: Database.Database }).db;
      const row = db
        .prepare("SELECT created_at FROM memories WHERE id = 'imp-iso'")
        .get() as { created_at: string };
      expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(Date.parse(row.created_at + "Z")).toBe(Date.parse("2026-01-15T10:30:00.000Z"));
    });
  });

  describe("recall query parsing", () => {
    beforeEach(async () => {
      await provider.remember({ content: "matt likes coffee in the morning" });
      await provider.remember({ content: "the cat sat on the mat" });
      await provider.remember({ content: "secrets and passwords" });
    });

    it("returns nothing for an empty query", async () => {
      expect(await provider.recall({ query: "" })).toEqual([]);
    });

    it("returns nothing for a whitespace-only query", async () => {
      expect(await provider.recall({ query: "   " })).toEqual([]);
    });

    it("returns nothing for a single-character query (filtered as too short)", async () => {
      // tokens of length 1 are filtered in tokenisation
      expect(await provider.recall({ query: "a" })).toEqual([]);
    });

    it("matches a single multi-character token", async () => {
      const hits = await provider.recall({ query: "coffee" });
      expect(hits.map((h) => h.content)).toContain("matt likes coffee in the morning");
    });

    it("OR-joins multi-word queries — any matching token is enough", async () => {
      const hits = await provider.recall({ query: "coffee passwords" });
      const contents = hits.map((h) => h.content);
      expect(contents).toContain("matt likes coffee in the morning");
      expect(contents).toContain("secrets and passwords");
    });

    it("strips punctuation when tokenising", async () => {
      const hits = await provider.recall({ query: "coffee?!" });
      expect(hits.map((h) => h.content)).toContain("matt likes coffee in the morning");
    });

    it("respects the limit parameter", async () => {
      const hits = await provider.recall({ query: "the", limit: 1 });
      expect(hits.length).toBeLessThanOrEqual(1);
    });
  });

  describe("recall scoping and soft-delete", () => {
    it("surfaces global memories in any space-scoped query", async () => {
      await provider.remember({ content: "global rule" });
      const hits = await provider.recall({ query: "global", space_id: "home" });
      expect(hits.map((h) => h.content)).toContain("global rule");
    });

    it("excludes other-space memories from a space-scoped query", async () => {
      await provider.remember({ content: "work-only secret", space_id: "work" });
      const hits = await provider.recall({ query: "secret", space_id: "home" });
      expect(hits.map((h) => h.content)).not.toContain("work-only secret");
    });

    it("forgotten memories do not surface in subsequent recall", async () => {
      const m = await provider.remember({ content: "forget me" });
      await provider.forget(m.id);
      const hits = await provider.recall({ query: "forget" });
      expect(hits.map((h) => h.id)).not.toContain(m.id);
    });
  });

  describe("forget", () => {
    it("returns false for an unknown id (does not throw)", async () => {
      await expect(provider.forget("does-not-exist")).resolves.toBe(false);
    });

    it("returns true when a row is actually removed", async () => {
      const m = await provider.remember({ content: "delete me" });
      await expect(provider.forget(m.id)).resolves.toBe(true);
    });
  });

  describe("R6 recall provenance", () => {
    it("getRecalledBySession returns each memory once even after multiple recalls", async () => {
      const m = await provider.remember({ content: "recall me twice" });
      await provider.recall({ query: "recall", recalling_session_id: "sess_x" });
      await provider.recall({ query: "recall", recalling_session_id: "sess_x" });
      const recalled = await provider.getRecalledBySession("sess_x");
      const ids = recalled.map((r) => r.id);
      expect(ids.filter((id) => id === m.id)).toHaveLength(1);
    });

    it("getRecalledBySession does not record recalls without a session id", async () => {
      await provider.remember({ content: "anonymous recall" });
      await provider.recall({ query: "anonymous" });
      const recalled = await provider.getRecalledBySession("sess_y");
      expect(recalled).toHaveLength(0);
    });
  });

  describe("search", () => {
    it("returns FTS-ranked rows without bumping recall stats", async () => {
      const a = await provider.remember({ content: "auth middleware notes", space_id: "tokinvest" });
      await provider.remember({ content: "completely unrelated note about cooking", space_id: "tokinvest" });

      // Prime access_count to a non-zero baseline. Without this the test
      // passes vacuously: access_count defaults to 0 and remember() does
      // not bump it, so before === after === 0 even if search() were
      // calling postRecallTxn.
      const db = (provider as unknown as { db: import("better-sqlite3").Database }).db;
      db.prepare("UPDATE memories SET access_count = 5 WHERE id = ?").run(a.id);

      const hits = await provider.search({ query: "auth" });

      expect(hits.map(h => h.id)).toContain(a.id);
      expect(hits.length).toBe(1);

      const after = db.prepare("SELECT access_count FROM memories WHERE id = ?").get(a.id) as { access_count: number };
      expect(after.access_count).toBe(5);
    });

    it("scopes to a space when space_id is set, plus globals", async () => {
      const inSpace = await provider.remember({ content: "scoped finding", space_id: "tokinvest" });
      const global = await provider.remember({ content: "global finding" });
      await provider.remember({ content: "other space finding", space_id: "other" });

      const hits = await provider.search({ query: "finding", space_id: "tokinvest" });
      const ids = hits.map(h => h.id);
      expect(ids).toContain(inSpace.id);
      expect(ids).toContain(global.id);
      expect(ids.length).toBe(2);
    });

    it("returns empty array when query has no usable terms", async () => {
      await provider.remember({ content: "anything" });
      expect(await provider.search({ query: "" })).toEqual([]);
      expect(await provider.search({ query: "?!" })).toEqual([]);
    });
  });
});

describe("schema migration — memory_events + memory_payloads", () => {
  it("creates memory_events with the expected columns", async () => {
    const t = tmp("mem-events-");
    const provider = new SqliteFtsMemoryProvider(t);
    await provider.init();
    const db = new Database(join(t, "memory.db"));
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
    const t = tmp("mem-check-");
    const provider = new SqliteFtsMemoryProvider(t);
    await provider.init();
    const db = new Database(join(t, "memory.db"));
    expect(() => db.prepare(
      `INSERT INTO memory_events (event_id, memory_id, event_type, created_at)
       VALUES ('ev-bad', 'm', 'bogus', 0)`,
    ).run()).toThrow(/CHECK constraint failed/);
    db.close();
    provider.close();
  });

  it("creates memory_payloads with the expected columns", async () => {
    const t = tmp("mem-payloads-");
    const provider = new SqliteFtsMemoryProvider(t);
    await provider.init();
    const db = new Database(join(t, "memory.db"));
    const cols = db.prepare("PRAGMA table_info(memory_payloads)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(["content", "memory_id", "purged_at", "tags"]);
    db.close();
    provider.close();
  });

  it("adds purged_at to memories", async () => {
    const t = tmp("mem-purgedat-");
    const provider = new SqliteFtsMemoryProvider(t);
    await provider.init();
    const db = new Database(join(t, "memory.db"));
    const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "purged_at")).toBe(true);
    db.close();
    provider.close();
  });

  it("re-running init() is idempotent", async () => {
    const t = tmp("mem-idem-");
    const provider1 = new SqliteFtsMemoryProvider(t);
    await provider1.init();
    provider1.close();
    const provider2 = new SqliteFtsMemoryProvider(t);
    await expect(provider2.init()).resolves.not.toThrow();
    provider2.close();
  });
});

describe("event write API — writeCreated", () => {
  it("inserts an event, payload, and materialised memories row", async () => {
    const t = tmp("ev-created-");
    const provider = new SqliteFtsMemoryProvider(t);
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
    const t = tmp("ev-pending-");
    const provider = new SqliteFtsMemoryProvider(t);
    await provider.init();
    const { event_id } = provider.writeCreated({ content: "pending" });
    const db = new Database(join(t, "memory.db"));
    const row = db.prepare("SELECT cloud_synced_at FROM memory_events WHERE event_id = ?").get(event_id) as { cloud_synced_at: number | null };
    expect(row.cloud_synced_at).toBeNull();
    db.close();
    provider.close();
  });

  it("writeCreated records cloud_owner_id on the event row", async () => {
    const t = tmp("ev-owner-");
    const provider = new SqliteFtsMemoryProvider(t);
    await provider.init();
    const { event_id } = provider.writeCreated({
      content: "owner test",
      cloud_owner_id: "user-pro-123",
    });
    const db = new Database(join(t, "memory.db"));
    const row = db.prepare("SELECT cloud_owner_id FROM memory_events WHERE event_id = ?")
      .get(event_id) as { cloud_owner_id: string | null };
    expect(row.cloud_owner_id).toBe("user-pro-123");
    db.close();
    provider.close();
  });

  it("writeForgotten records cloud_owner_id on the event row", async () => {
    const t = tmp("ev-forget-owner-");
    const provider = new SqliteFtsMemoryProvider(t);
    await provider.init();
    const { memory_id } = provider.writeCreated({ content: "owned" });
    provider.writeForgotten(memory_id, "user-pro-456");
    const db = new Database(join(t, "memory.db"));
    const row = db.prepare(
      `SELECT cloud_owner_id FROM memory_events WHERE memory_id = ? AND event_type = 'memory_forgotten'`,
    ).get(memory_id) as { cloud_owner_id: string | null };
    expect(row.cloud_owner_id).toBe("user-pro-456");
    db.close();
    provider.close();
  });

  it("remember dedupes empty content within same scope", async () => {
    const t = tmp("dedupe-empty-");
    const provider = new SqliteFtsMemoryProvider(t);
    await provider.init();
    const m1 = await provider.remember({ content: "" });
    const m2 = await provider.remember({ content: "" });
    expect(m1.id).toBe(m2.id);
    const list = await provider.list();
    expect(list).toHaveLength(1);
    provider.close();
  });
});

describe("event write API — writeForgotten / writePurged / precedence", () => {
  async function fresh() {
    const t = tmp("ev-prec-");
    const provider = new SqliteFtsMemoryProvider(t);
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
    const t = tmp("ev-prec-purge-");
    const provider = new SqliteFtsMemoryProvider(t);
    await provider.init();
    const { memory_id } = provider.writeCreated({ content: "AKIA-secret-key" });
    expect(provider.writePurged(memory_id)).toBe(true);
    const found = await provider.recall({ query: "AKIA" });
    expect(found).toHaveLength(0);
    const list = await provider.list();
    expect(list).toHaveLength(0);
    // Payload content must be physically nulled (spec Q7 footgun).
    const db = new Database(join(t, "memory.db"));
    const row = db.prepare(`SELECT content, purged_at FROM memory_payloads WHERE memory_id = ?`).get(memory_id) as { content: string | null; purged_at: number | null };
    expect(row.content).toBeNull();
    expect(row.purged_at).not.toBeNull();
    db.close();
    provider.close();
  });

  it("late create after purge does not restore content", async () => {
    const t = tmp("ev-prec-late-");
    const provider = new SqliteFtsMemoryProvider(t);
    await provider.init();
    const memory_id = "11111111-1111-1111-1111-111111111111";
    // Simulate purge-arrives-before-create by writing the purge event first.
    provider.writePurged(memory_id);
    // Now writeCreated for the same id.
    provider.writeCreated({ memory_id, content: "should-not-appear" });
    const list = await provider.list();
    expect(list).toHaveLength(0);
    const found = await provider.recall({ query: "should-not-appear" });
    expect(found).toHaveLength(0);
    // The late create's content must NOT have landed in the payload — purge dominates.
    const db = new Database(join(t, "memory.db"));
    const row = db.prepare(`SELECT content FROM memory_payloads WHERE memory_id = ?`).get(memory_id) as { content: string | null };
    expect(row.content).toBeNull();
    db.close();
    provider.close();
  });

  it("forget after create then forget again is a no-op", async () => {
    const provider = await fresh();
    const { memory_id } = provider.writeCreated({ content: "hi" });
    expect(provider.writeForgotten(memory_id)).toBe(true);
    expect(provider.writeForgotten(memory_id)).toBe(false); // idempotent: returns false on no-op
    provider.close();
  });

  it("re-materialise after purge does not bump purged_at (idempotent)", async () => {
    const t = tmp("idem-purgedat-");
    const provider = new SqliteFtsMemoryProvider(t);
    await provider.init();
    const { memory_id } = provider.writeCreated({ content: "secret" });
    expect(provider.writePurged(memory_id)).toBe(true);

    // Capture the initial purged_at (set during writePurged → materialiseMemory).
    const db = new Database(join(t, "memory.db"));
    const before = db.prepare(
      `SELECT purged_at FROM memory_payloads WHERE memory_id = ?`,
    ).get(memory_id) as { purged_at: number };
    expect(before.purged_at).not.toBeNull();

    // Force a re-materialise. With Date.now() this would bump purged_at.
    // With the event's created_at as the source, it stays the same.
    provider.materialiseMemory(memory_id);
    const after = db.prepare(
      `SELECT purged_at FROM memory_payloads WHERE memory_id = ?`,
    ).get(memory_id) as { purged_at: number };
    expect(after.purged_at).toBe(before.purged_at);
    db.close();
    provider.close();
  });
});

describe("provider.purge", () => {
  it("purges existing memory and returns true", async () => {
    const t = tmp("purge-");
    const provider = new SqliteFtsMemoryProvider(t);
    await provider.init();
    const m = await provider.remember({ content: "secret-content" });
    expect(await provider.purge(m.id)).toBe(true);
    expect(await provider.recall({ query: "secret-content" })).toHaveLength(0);
    provider.close();
  });

  it("returns false when memory does not exist", async () => {
    const t = tmp("purge-missing-");
    const provider = new SqliteFtsMemoryProvider(t);
    await provider.init();
    expect(await provider.purge("nonexistent")).toBe(false);
    provider.close();
  });
});

describe("backfill from legacy memories rows", () => {
  it("creates memory_created events for pre-existing rows on init()", async () => {
    const t = tmp("bf-");
    // First boot: write memories the old way (skip writeCreated path) by
    // simulating a legacy row directly in the DB.
    const provider1 = new SqliteFtsMemoryProvider(t);
    await provider1.init();
    const db1 = new Database(join(t, "memory.db"));
    db1.prepare(`DELETE FROM memory_events`).run();
    db1.prepare(`DELETE FROM memory_payloads`).run();
    db1.prepare(
      `INSERT INTO memories (id, content, tags, created_at, updated_at)
       VALUES ('legacy-1', 'old memory', '["legacy"]', '2026-01-01', '2026-01-01')`,
    ).run();
    db1.close();
    provider1.close();

    // Second boot: backfill should kick in.
    const provider2 = new SqliteFtsMemoryProvider(t);
    await provider2.init();
    const db2 = new Database(join(t, "memory.db"));
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
    const t = tmp("bf-idem-");
    const provider1 = new SqliteFtsMemoryProvider(t);
    await provider1.init();
    await provider1.remember({ content: "hello" });
    provider1.close();

    const provider2 = new SqliteFtsMemoryProvider(t);
    await provider2.init();
    const db = new Database(join(t, "memory.db"));
    const count = db.prepare(`SELECT COUNT(*) as c FROM memory_events`).get() as { c: number };
    expect(count.c).toBe(1); // one create event from the original remember(), not duplicated
    db.close();
    provider2.close();
  });

  it("emits memory_forgotten for legacy soft-deleted rows", async () => {
    const t = tmp("bf-forgotten-");
    const provider1 = new SqliteFtsMemoryProvider(t);
    await provider1.init();
    const db1 = new Database(join(t, "memory.db"));
    db1.prepare(
      `INSERT INTO memories (id, content, tags, superseded_by, created_at, updated_at)
       VALUES ('legacy-2', 'gone', '[]', 'forgotten', '2026-01-01', '2026-01-01')`,
    ).run();
    db1.close();
    provider1.close();

    const provider2 = new SqliteFtsMemoryProvider(t);
    await provider2.init();
    const db2 = new Database(join(t, "memory.db"));
    const types = db2.prepare(
      `SELECT event_type FROM memory_events WHERE memory_id = ? ORDER BY created_at`,
    ).all("legacy-2") as Array<{ event_type: string }>;
    expect(types.map((r) => r.event_type)).toEqual(["memory_created", "memory_forgotten"]);
    db2.close();
    provider2.close();
  });

  it("preserves legacy created_at when parseable", async () => {
    const t = tmp("bf-ts-");
    const provider1 = new SqliteFtsMemoryProvider(t);
    await provider1.init();
    const db1 = new Database(join(t, "memory.db"));
    db1.prepare(
      `INSERT INTO memories (id, content, tags, created_at, updated_at)
       VALUES ('legacy-ts', 'has timestamp', '[]', '2026-01-15 10:30:00', '2026-01-15 10:30:00')`,
    ).run();
    db1.close();
    provider1.close();

    const provider2 = new SqliteFtsMemoryProvider(t);
    await provider2.init();
    const db2 = new Database(join(t, "memory.db"));
    const ev = db2.prepare(
      `SELECT created_at FROM memory_events WHERE memory_id = ?`,
    ).get("legacy-ts") as { created_at: number };
    // Should match 2026-01-15 10:30:00 UTC ≈ 1768516200000, NOT Date.now()
    const expected = Date.parse("2026-01-15T10:30:00Z");
    expect(ev.created_at).toBe(expected);
    db2.close();
    provider2.close();
  });

  it("preserves legacy created_at for date-only legacy timestamps", async () => {
    const t = tmp("bf-ts-dateonly-");
    const provider1 = new SqliteFtsMemoryProvider(t);
    await provider1.init();
    const db1 = new Database(join(t, "memory.db"));
    db1.prepare(
      `INSERT INTO memories (id, content, tags, created_at, updated_at)
       VALUES ('legacy-date', 'date-only', '[]', '2026-01-15', '2026-01-15')`,
    ).run();
    db1.close();
    provider1.close();

    const provider2 = new SqliteFtsMemoryProvider(t);
    await provider2.init();
    const db2 = new Database(join(t, "memory.db"));
    const ev = db2.prepare(
      `SELECT created_at FROM memory_events WHERE memory_id = ?`,
    ).get("legacy-date") as { created_at: number };
    // Should match midnight UTC for 2026-01-15, NOT Date.now()
    expect(ev.created_at).toBe(Date.parse("2026-01-15T00:00:00Z"));
    db2.close();
    provider2.close();
  });

  it("nulls payload content for legacy rows with superseded_by = 'purged'", async () => {
    const t = tmp("bf-purged-");
    const provider1 = new SqliteFtsMemoryProvider(t);
    await provider1.init();
    const db1 = new Database(join(t, "memory.db"));
    db1.prepare(
      `INSERT INTO memories (id, content, tags, superseded_by, created_at, updated_at)
       VALUES ('legacy-purged', 'AKIA-leak', '["sensitive"]', 'purged', '2026-01-01', '2026-01-01')`,
    ).run();
    db1.close();
    provider1.close();

    const provider2 = new SqliteFtsMemoryProvider(t);
    await provider2.init();
    const db2 = new Database(join(t, "memory.db"));
    const types = db2.prepare(
      `SELECT event_type FROM memory_events WHERE memory_id = ? ORDER BY created_at`,
    ).all("legacy-purged") as Array<{ event_type: string }>;
    expect(types.map((r) => r.event_type)).toEqual(["memory_created", "memory_purged"]);
    const pay = db2.prepare(
      `SELECT content, purged_at FROM memory_payloads WHERE memory_id = ?`,
    ).get("legacy-purged") as { content: string | null; purged_at: number | null };
    expect(pay.content).toBeNull();
    expect(pay.purged_at).not.toBeNull();

    // Q7: the legacy memories row and its FTS entry must also be gone —
    // purge is hard-redaction across all local storage, not just the
    // payload store.
    const memRow = db2.prepare(
      `SELECT id FROM memories WHERE id = ?`,
    ).get("legacy-purged") as { id: string } | undefined;
    expect(memRow).toBeUndefined();

    const recalled = await provider2.recall({ query: "AKIA-leak" });
    expect(recalled).toHaveLength(0);
    db2.close();
    provider2.close();
  });
});

describe("onWrite hook", () => {
  it("fires after remember (writeCreated path)", async () => {
    const t = tmp("onwrite-remember-");
    const provider = new SqliteFtsMemoryProvider(t);
    await provider.init();
    let calls = 0;
    provider.setOnWrite(() => { calls++; });
    await provider.remember({ content: "hook test" });
    // queueMicrotask fires after the current microtask checkpoint
    await Promise.resolve();
    expect(calls).toBe(1);
    provider.close();
  });

  it("fires after forget and purge (writeForgotten / writePurged paths)", async () => {
    const t = tmp("onwrite-forget-purge-");
    const provider = new SqliteFtsMemoryProvider(t);
    await provider.init();
    let calls = 0;
    provider.setOnWrite(() => { calls++; });
    const { memory_id } = provider.writeCreated({ content: "to be forgotten" });
    await Promise.resolve(); // drain writeCreated hook
    calls = 0; // reset after writeCreated

    provider.writeForgotten(memory_id);
    await Promise.resolve();
    expect(calls).toBe(1);

    const { memory_id: mid2 } = provider.writeCreated({ content: "to be purged" });
    await Promise.resolve();
    calls = 0; // reset after second writeCreated

    provider.writePurged(mid2);
    await Promise.resolve();
    expect(calls).toBe(1);
    provider.close();
  });
});
