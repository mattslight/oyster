// session-sync-service.ts — cross-device sync of agent session metadata (#322).
//
// Pattern: row-level dirty tracking on the `sessions` table. The watcher (or
// any other writer) calls markDirty() when a session row changes; pushPending()
// drains dirty rows for the current Pro owner up to cloud, marks them synced
// on the round-trip. Pro-only. Profile-binding gate prevents account A's
// metadata polluting account B's local SQLite.
//
// Mirrors memory-sync-service.ts for the gate / in-flight guard / fetch shape,
// and spaces' sync_dirty_at + cloud_synced_at columns for the dirty predicate.
//
// PR 1 of 3: metadata push only.
//   PR 2 will add `pull()` + remote_sessions table + lazy bytes pull.
//   PR 3 will add the UI surface (cross-device cards + Resume on this device).
// `pushBytes()` and the 5-min snapshot timer also land in a follow-up once
// the cloud worker route exists.

import type Database from "better-sqlite3";
import type { ProfileBindingService } from "./profile-binding-service.js";

interface SyncUser { id: string; email: string; tier: string }

export interface SessionSyncDeps {
  db: Database.Database;
  /** Required: gates pull AND push on profile ownership so a second Pro
   *  account signing into the same local profile cannot pollute the local
   *  SQLite with their cloud sessions. Mirrors memory sync. */
  profileBinding: ProfileBindingService;
  currentUser: () => SyncUser | null;
  sessionToken: () => string | null;
  workerBase: string;
  fetch: typeof fetch;
}

export interface SessionSyncService {
  reconcile(): Promise<{ pulled: number; pushed: number }>;
  pushPending(): Promise<number>;
  /** Mark a session row dirty so the next pushPending() picks it up. The
   *  watcher should call this on every material session change. */
  markDirty(sessionId: string, ownerId: string, at?: number): void;
}

const BATCH_SIZE = 100;

function isProSession(deps: SessionSyncDeps): { user: SyncUser; token: string } | null {
  const user = deps.currentUser();
  const token = deps.sessionToken();
  if (!user || !token || user.tier !== "pro") return null;
  if (!deps.profileBinding.isOwnedBy(user.id)) {
    console.warn(
      `[sessions] sync blocked — profile is bound to a different account; current=${user.id}, bound=${deps.profileBinding.getBoundOwner()}`,
    );
    return null;
  }
  return { user, token };
}

interface OutgoingSession {
  id: string;
  agent: string;
  title: string | null;
  state: string;
  started_at: string;
  ended_at: string | null;
  model: string | null;
  cwd: string | null;
  last_event_at: string;
  sync_dirty_at: number;
}

export function createSessionSyncService(deps: SessionSyncDeps): SessionSyncService {
  let inFlightPush: Promise<number> | null = null;

  const markDirtyStmt = deps.db.prepare(
    `UPDATE sessions
        SET sync_dirty_at  = ?,
            cloud_owner_id = ?
      WHERE id = ?`,
  );

  function markDirty(sessionId: string, ownerId: string, at = Date.now()): void {
    markDirtyStmt.run(at, ownerId, sessionId);
  }

  // Dirty predicate mirrors space-sync: a row is pending when sync_dirty_at
  // is set AND cloud_synced_at is either NULL or older than the dirty mark.
  // Restricting to cloud_owner_id = current Pro user is the account-switching
  // guard (don't push another owner's events; same posture as memory sync).
  const scanDirty = deps.db.prepare(
    `SELECT id, agent, title, state, started_at, ended_at, model, cwd,
            last_event_at, sync_dirty_at
       FROM sessions
      WHERE sync_dirty_at IS NOT NULL
        AND cloud_owner_id = ?
        AND (cloud_synced_at IS NULL OR cloud_synced_at < sync_dirty_at)
      ORDER BY sync_dirty_at ASC
      LIMIT ?`,
  );

  // Owner-scoped on the WHERE clause: if the server somehow echoes back an id
  // that belongs to a different cloud_owner_id (account-switch race, server
  // bug), refuse to mark it synced. Defensive — push is already owner-scoped
  // on the scan side, but layered checks are cheap.
  const markSyncedStmt = deps.db.prepare(
    `UPDATE sessions
        SET cloud_synced_at = ?
      WHERE id = ? AND cloud_owner_id = ?`,
  );

  async function doPushPending(): Promise<number> {
    const session = isProSession(deps);
    if (!session) return 0;

    let totalAccepted = 0;
    const MAX_BATCHES = 1000;  // defensive safety cap

    for (let i = 0; i < MAX_BATCHES; i++) {
      const pending = scanDirty.all(session.user.id, BATCH_SIZE) as OutgoingSession[];
      if (pending.length === 0) break;

      let res: Response;
      try {
        res = await deps.fetch(`${deps.workerBase}/api/sessions/metadata`, {
          method: "POST",
          headers: { Cookie: `oyster_session=${session.token}`, "content-type": "application/json" },
          body: JSON.stringify({ sessions: pending }),
        });
      } catch (err) {
        console.warn("[sessions] pushPending failed:", err);
        return totalAccepted;
      }
      if (!res.ok) {
        console.warn(`[sessions] pushPending non-ok ${res.status}`);
        return totalAccepted;
      }
      const body = await res.json().catch(() => null) as { accepted?: string[] } | null;
      const accepted = body?.accepted ?? [];

      // Mark accepted rows synced. Use Date.now() as cloud_synced_at — any
      // sync_dirty_at <= this value is considered cleared. If the row was
      // dirtied AGAIN between scan and ack, the new sync_dirty_at will be
      // > cloud_synced_at and the next scan picks it up.
      const now = Date.now();
      const tx = deps.db.transaction(() => {
        for (const id of accepted) markSyncedStmt.run(now, id, session.user.id);
      });
      tx();
      totalAccepted += accepted.length;

      if (accepted.length > 0) {
        console.log(`[sessions] pushed: accepted=${accepted.length}`);
      }
      // If nothing was accepted, breaking avoids hot-looping on a server
      // that returns empty acks.
      if (accepted.length === 0) break;
    }

    return totalAccepted;
  }

  // Capture the service object so methods don't depend on `this` binding —
  // safe to pass `service.reconcile` directly into a setInterval / event
  // emitter callback. Mirrors the memory-sync-service shape.
  const service: SessionSyncService = {
    async reconcile() {
      const session = isProSession(deps);
      if (!session) return { pulled: 0, pushed: 0 };
      // Pull is PR 2 territory; for now reconcile = pushPending.
      const pushed = await service.pushPending();
      return { pulled: 0, pushed };
    },

    async pushPending() {
      if (inFlightPush) return inFlightPush;
      inFlightPush = doPushPending();
      try {
        return await inFlightPush;
      } finally {
        inFlightPush = null;
      }
    },

    markDirty,
  };
  return service;
}
