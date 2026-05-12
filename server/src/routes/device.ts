// /api/device/* route bucket.
//
// Tiny route module — currently exposes only the local device identity
// (id + human-readable label) so the web UI can decide which sessions
// originated on THIS device vs. another one. Sourced from the
// device_identity singleton seeded at install time.
//
// Returns true when handled; caller falls through to other routes on false.

import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import type { RouteCtx } from "../http-utils.js";

export interface DeviceRouteDeps {
  db: Database.Database;
}

export interface DeviceIdentityResponse {
  /** Stable UUID assigned to this machine on first install. Used to
   *  distinguish local from remote sessions, never user-facing. */
  deviceId: string;
  /** Human-readable label, defaults to the machine's hostname at install
   *  time. UI renders this in the cross-device session chip. */
  label: string;
}

export async function tryHandleDeviceRoute(
  req: IncomingMessage,
  _res: ServerResponse,
  url: string,
  ctx: RouteCtx,
  deps: DeviceRouteDeps,
): Promise<boolean> {
  if (req.method !== "GET" || url !== "/api/device/identity") return false;

  // The local server permits CORS broadly so the in-browser UI can hit it;
  // gate this endpoint to localhost-origin requests since deviceId is a
  // stable per-machine UUID (fingerprinting / leak risk if cross-origin
  // pages could read it). Mirrors the gate other /api routes use for
  // device-sensitive surfaces.
  if (ctx.rejectIfNonLocalOrigin()) return true;

  const { db } = deps;
  const { sendJson } = ctx;

  const row = db.prepare(
    `SELECT device_id, label FROM device_identity WHERE id = 1 LIMIT 1`,
  ).get() as { device_id: string; label: string } | undefined;

  // The row is seeded at server boot in index.ts (INSERT OR IGNORE), so a
  // missing row would mean a pre-seed race against this endpoint or a
  // corrupted DB. Surface as 503 so the client can retry rather than
  // silently rendering with no device identity.
  if (!row) {
    sendJson({ error: "device_identity_not_ready" }, 503);
    return true;
  }
  const payload: DeviceIdentityResponse = { deviceId: row.device_id, label: row.label };
  sendJson(payload, 200);
  return true;
}
