import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SqliteFtsMemoryProvider } from "../src/memory-store.js";
import { tryHandleMemoryRoute } from "../src/routes/memories.js";

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "oyster-mem-route-"));
  const provider = new SqliteFtsMemoryProvider(dir);
  await provider.init();

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const ctx = {
      sendJson: (body: unknown, status = 200) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      },
      sendError: (e: unknown) => {
        res.statusCode = 500;
        res.end(String(e));
      },
      readJsonBody: async () => ({}),
      rejectIfNonLocalOrigin: () => false,
    };
    const handled = await tryHandleMemoryRoute(req, res, url, ctx as never, {
      memoryProvider: provider,
      resolveCurrentOwnerId: () => null,
      memorySync: { reconcile: async () => ({ pulled: 0, pushed: 0 }), pushPending: async () => {}, pull: async () => 0 } as never,
    });
    if (!handled) { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return { dir, provider, server, port };
}

async function teardown(s: { dir: string; provider: SqliteFtsMemoryProvider; server: Server }) {
  s.provider.close();
  rmSync(s.dir, { recursive: true, force: true });
  await new Promise<void>((r) => s.server.close(() => r()));
}

describe("GET /api/memories/search", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { s = await setup(); });
  afterEach(async () => { await teardown(s); });

  it("returns matching memories ordered by FTS rank", async () => {
    await s.provider.remember({ content: "auth middleware design", space_id: "tokinvest" });
    await s.provider.remember({ content: "unrelated note", space_id: "tokinvest" });

    const r = await fetch(`http://localhost:${s.port}/api/memories/search?q=auth`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.length).toBe(1);
    expect(body[0].content).toContain("auth");
  });

  it("honors space_id", async () => {
    await s.provider.remember({ content: "finding x", space_id: "a" });
    await s.provider.remember({ content: "finding y", space_id: "b" });
    const r = await fetch(`http://localhost:${s.port}/api/memories/search?q=finding&space_id=a`);
    const body = await r.json();
    expect(body.length).toBe(1);
    expect(body[0].space_id).toBe("a");
  });

  it("returns [] for empty query", async () => {
    const r = await fetch(`http://localhost:${s.port}/api/memories/search?q=`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });
});
