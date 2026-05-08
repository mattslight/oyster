import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applySchema } from "./fixtures/seed.js";

describe("synced_memory_events / synced_memory_payloads schema", () => {
  beforeAll(async () => {
    await applySchema();
  });

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
