// GET /api/device/identity — surfaces the local device_identity singleton
// to the web UI so it can distinguish local from remote sessions and
// render the cross-device chip.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { tryHandleDeviceRoute } from "../src/routes/device.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE device_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      device_id TEXT NOT NULL,
      label TEXT NOT NULL
    );
  `);
  return db;
}

function fakeCtx() {
  const captured: { status?: number; json?: unknown } = {};
  const ctx = {
    sendJson: (j: unknown, s = 200) => { captured.json = j; captured.status = s; },
    sendError: (err: unknown, s = 500) => {
      captured.json = { error: err instanceof Error ? err.message : String(err) };
      captured.status = s;
    },
    rejectIfNonLocalOrigin: () => false,
    readJsonBody: async () => ({}),
  };
  return { ctx, captured };
}

describe("GET /api/device/identity", () => {
  it("returns the seeded device id + label", async () => {
    const db = makeDb();
    db.prepare(`INSERT INTO device_identity (id, device_id, label) VALUES (1, ?, ?)`)
      .run("dev-mac-uuid", "MacBookPro");
    const { ctx, captured } = fakeCtx();
    const req = { method: "GET" } as any;
    const handled = await tryHandleDeviceRoute(req, {} as any, "/api/device/identity", ctx as any, { db });
    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.json).toEqual({ deviceId: "dev-mac-uuid", label: "MacBookPro" });
  });

  it("503 when device_identity row not seeded", async () => {
    const db = makeDb();
    const { ctx, captured } = fakeCtx();
    const req = { method: "GET" } as any;
    const handled = await tryHandleDeviceRoute(req, {} as any, "/api/device/identity", ctx as any, { db });
    expect(handled).toBe(true);
    expect(captured.status).toBe(503);
    expect(captured.json).toMatchObject({ error: "device_identity_not_ready" });
  });

  it("passes through (returns false) on non-matching URL", async () => {
    const db = makeDb();
    const { ctx } = fakeCtx();
    const req = { method: "GET" } as any;
    const handled = await tryHandleDeviceRoute(req, {} as any, "/api/something-else", ctx as any, { db });
    expect(handled).toBe(false);
  });

  it("passes through (returns false) on POST", async () => {
    const db = makeDb();
    db.prepare(`INSERT INTO device_identity (id, device_id, label) VALUES (1, 'x', 'y')`).run();
    const { ctx } = fakeCtx();
    const req = { method: "POST" } as any;
    const handled = await tryHandleDeviceRoute(req, {} as any, "/api/device/identity", ctx as any, { db });
    expect(handled).toBe(false);
  });
});
