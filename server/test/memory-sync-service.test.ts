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
