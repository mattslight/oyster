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
  /** Optional: invoked after a successful pull when applied > 0. Used by the
   *  server entry point to broadcast a `memory_changed` SSE so the UI
   *  re-fetches its memory list. Cloud-pulled events bypass the local
   *  `onWrite` hook, so without this the periodic poll lands fresh data
   *  silently and the panel stays stale until a focus/refresh trigger. */
  onApplied?: (applied: number) => void;
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
  // In-flight guard: a single drain pass at a time. Concurrent callers
  // (e.g. multiple onWrite triggers in quick succession) await the same
  // promise rather than racing.
  let inFlightPush: Promise<number> | null = null;
  let inFlightReconcile: Promise<{ pulled: number; pushed: number }> | null = null;

  async function doPushPending(): Promise<number> {
      const session = isProSession(deps);
      if (!session) return 0;

      type Pending = {
        event_id: string; memory_id: string; event_type: OutgoingEvent["event_type"];
        space_id: string | null; created_at: number;
      };

      // Hoist prepared statements out of the drain loop — recompiling the same
      // SQL each iteration is wasteful for fresh-sign-in flushes that may run
      // many batches.
      const scanPending = deps.db.prepare(
        `SELECT event_id, memory_id, event_type, space_id, created_at
           FROM memory_events
          WHERE cloud_synced_at IS NULL
            AND cloud_owner_id = ?
          ORDER BY
            CASE event_type
              WHEN 'memory_purged'    THEN 0
              WHEN 'memory_forgotten' THEN 1
              WHEN 'memory_created'   THEN 2
            END,
            created_at ASC
          LIMIT ?`,
      );
      const fetchPayload = deps.db.prepare(
        `SELECT content, tags FROM memory_payloads WHERE memory_id = ?`,
      );

      // Drain loop: keep flushing batches until no pending events remain
      // for the current owner. Without this, a fresh sign-in with N>BATCH
      // pending events would only push the first batch, then stall until
      // the next reconcile trigger.
      let totalAccepted = 0;
      let conflictPullScheduled = false;
      // Defensive safety cap so a misbehaving server can't loop forever.
      const MAX_BATCHES = 1000;

      for (let i = 0; i < MAX_BATCHES; i++) {
        const pending = scanPending.all(session.user.id, BATCH_SIZE) as Pending[];

        if (pending.length === 0) break;

        const events: OutgoingEvent[] = pending.map((p) => {
          const out: OutgoingEvent = {
            event_id: p.event_id, memory_id: p.memory_id, event_type: p.event_type,
            space_id: p.space_id, created_at: p.created_at,
          };
          if (p.event_type === "memory_created") {
            const pay = fetchPayload.get(p.memory_id) as { content: string | null; tags: string } | undefined;
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

        // Success log: only when something actually moved through this batch.
        // Quiet in steady-state, visible when activity happens.
        const moved = accepted.length + duplicates.length;
        if (moved > 0) {
          console.log(`[memory] pushed: accepted=${accepted.length} duplicates=${duplicates.length}${conflicts.length ? ` conflicts=${conflicts.length}` : ""}${rejected.length ? ` rejected=${rejected.length}` : ""}`);
        }

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
        try { await pull(); } catch { /* swallowed; logged elsewhere */ }
      }

      return totalAccepted;
  }

  async function pull(): Promise<number> {
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
        // Purge-guard: never overwrite content/tags when a memory_purged event
        // exists locally for this memory_id. Belt-and-braces alongside
        // materialiseMemory's authoritative pass — keeps the invariant explicit
        // in SQL rather than relying on the post-pass call.
        `INSERT INTO memory_payloads (memory_id, content, tags, purged_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET
           content   = CASE
             WHEN EXISTS (SELECT 1 FROM memory_events
                            WHERE memory_id = memory_payloads.memory_id
                              AND event_type = 'memory_purged')
               THEN NULL
             ELSE excluded.content
           END,
           tags      = CASE
             WHEN EXISTS (SELECT 1 FROM memory_events
                            WHERE memory_id = memory_payloads.memory_id
                              AND event_type = 'memory_purged')
               THEN '[]'
             ELSE excluded.tags
           END,
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

      if (applied > 0) {
        console.log(`[memory] pulled: applied=${applied}`);
        try { deps.onApplied?.(applied); } catch (err) {
          console.warn("[memory] onApplied threw:", err);
        }
      }

      return applied;
  }

  const service: MemorySyncService = {
    async reconcile() {
      if (inFlightReconcile) return inFlightReconcile;
      const session = isProSession(deps);
      if (!session) return { pulled: 0, pushed: 0 };
      inFlightReconcile = (async () => {
        const pulled = await pull();
        const pushed = await service.pushPending();
        return { pulled, pushed };
      })();
      try {
        return await inFlightReconcile;
      } finally {
        inFlightReconcile = null;
      }
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

    pull,
  };
  return service;
}
