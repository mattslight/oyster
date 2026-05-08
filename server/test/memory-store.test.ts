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
});

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
