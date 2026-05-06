// space-sync-service.ts — cross-device sync of the local spaces table.
// Spec: docs/superpowers/specs/2026-05-06-spaces-sync-spinout-design.md
//
// Wedge of #319 (R1). Pattern: dirty-row push + pending-delete sweep + full
// pull on reconcile, fire-and-forget pushOne/pushDelete after each mutation.
// Pro-only — sync is gated on user.tier === "pro".
//
// IMPORTANT: this is the FIRST instance of cross-device row-sync. Before
// replicating this shape for memory (#318), session metadata, or artefact
// bytes (R7), evaluate PowerSync / ElectricSQL / Replicache / object-
// storage-only designs. See project_sync_build_vs_lease memory.

import type Database from "better-sqlite3";
import type { SpaceStore, SpaceRow } from "./space-store.js";

export interface SyncUser {
  id: string;
  email: string;
  tier: string;
}

export interface SpaceSyncDeps {
  db: Database.Database;
  store: SpaceStore;
  currentUser: () => SyncUser | null;
  sessionToken: () => string | null;
  workerBase: string;
  fetch: typeof fetch;
}

export interface SpaceSyncService {
  /** Pull cloud → local, then push live dirty rows, then push pending
   *  deletes. Idempotent. Called on sign-in (BEFORE backfillPublications,
   *  so the headline _cloud-fallback fix is immediate) and on app start
   *  when signed in. Pro-only — returns zeros for free / signed-out. */
  reconcile(): Promise<{ pulled: number; pushed: number; tombstoned: number }>;

  /** Fire-and-forget push for one row after a local mutation. Swallows
   *  network errors with a console.warn; the next reconcile() retries.
   *  Pro-only — no-op for free / signed-out. */
  pushOne(spaceId: string): Promise<void>;

  /** Fire-and-forget DELETE for a space the local server just soft-deleted.
   *  Marks the local tombstone synced on 200/404. Pro-only. */
  pushDelete(spaceId: string): Promise<void>;
}

interface CloudSpace {
  owner_id: string;
  space_id: string;
  display_name: string;
  color: string | null;
  parent_id: string | null;
  summary_title: string | null;
  summary_content: string | null;
  updated_at: number;
  deleted_at: number | null;
  created_at: number;
}

interface CloudDeleteResponse {
  space_id: string;
  deleted_at: number;
  updated_at: number;
}

/** Pro tier check. Spec: R1 (this wedge) is Pro-only per the requirements doc
 *  tier mapping. Keep in one place so it's easy to change if the gate moves. */
function isProSession(deps: SpaceSyncDeps): { user: SyncUser; token: string } | null {
  const user = deps.currentUser();
  const token = deps.sessionToken();
  if (!user || !token || user.tier !== "pro") return null;
  return { user, token };
}

export function createSpaceSyncService(deps: SpaceSyncDeps): SpaceSyncService {
  return {
    async reconcile() {
      const session = isProSession(deps);
      if (!session) return { pulled: 0, pushed: 0, tombstoned: 0 };

      // ── Pull ──
      let res: Response;
      try {
        res = await deps.fetch(`${deps.workerBase}/api/spaces/mine`, {
          headers: { Cookie: `oyster_session=${session.token}` },
        });
      } catch (err) {
        console.warn("[spaces] reconcile pull failed:", err);
        return { pulled: 0, pushed: 0, tombstoned: 0 };
      }
      if (!res.ok) {
        console.warn(`[spaces] reconcile pull non-ok ${res.status}`);
        return { pulled: 0, pushed: 0, tombstoned: 0 };
      }

      const body = await res.json().catch(() => null) as { spaces?: CloudSpace[] } | null;
      const cloudRows = body?.spaces ?? [];

      let pulled = 0;
      let tombstoned = 0;

      // Raw SQL for the upsert path because store.update() filters by
      // UPDATABLE_COLUMNS and we need to set cloud_synced_at directly.
      // Note: NOT touching sync_dirty_at — leave it whatever it was. The
      // dirty predicate naturally goes clean because cloud_synced_at >=
      // sync_dirty_at after this write.
      const upsertStmt = deps.db.prepare(`
        INSERT INTO spaces
          (id, display_name, color, parent_id, summary_title, summary_content,
           scan_status, cloud_synced_at, updated_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'none', ?, datetime('now'), datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          display_name    = excluded.display_name,
          color           = excluded.color,
          parent_id       = excluded.parent_id,
          summary_title   = excluded.summary_title,
          summary_content = excluded.summary_content,
          cloud_synced_at = excluded.cloud_synced_at,
          updated_at      = datetime('now')
      `);

      for (const cloud of cloudRows) {
        if (cloud.deleted_at !== null) {
          // Tombstone application — preserve cloud's deleted_at as local's
          // deleted_at (cross-device tombstone provenance), and mark synced
          // so the pending-delete sweep doesn't re-push.
          const existing = deps.db.prepare(
            "SELECT id, deleted_at FROM spaces WHERE id = ?",
          ).get(cloud.space_id) as { id: string; deleted_at: number | null } | undefined;
          if (existing && existing.deleted_at === null) {
            deps.store.softDelete(cloud.space_id, cloud.deleted_at);
            tombstoned++;
          }
          // Mark synced unconditionally (also covers the case where local
          // had its own tombstone and they happen to match).
          if (existing) deps.store.markSynced(cloud.space_id, cloud.deleted_at);
          continue;
        }

        const existing = deps.db.prepare(
          "SELECT sync_dirty_at, cloud_synced_at FROM spaces WHERE id = ? AND deleted_at IS NULL",
        ).get(cloud.space_id) as { sync_dirty_at: number | null; cloud_synced_at: number | null } | undefined;

        if (!existing) {
          upsertStmt.run(
            cloud.space_id, cloud.display_name, cloud.color, cloud.parent_id,
            cloud.summary_title, cloud.summary_content, cloud.updated_at,
          );
          pulled++;
        } else {
          // LWW pull rule: cloud wins iff local has no dirty mark, OR cloud
          // is newer than local's dirty mark. Otherwise push step takes over.
          const localDirty = existing.sync_dirty_at;
          if (localDirty === null || cloud.updated_at > localDirty) {
            upsertStmt.run(
              cloud.space_id, cloud.display_name, cloud.color, cloud.parent_id,
              cloud.summary_title, cloud.summary_content, cloud.updated_at,
            );
            pulled++;
          }
          // else: local has unsynced changes newer than cloud; push handles it.
        }
      }

      // ── Push live dirty rows ──
      const dirty = deps.store.getDirtyRows();
      let pushed = 0;
      for (const row of dirty) {
        const ok = await pushRow(deps, session.token, row);
        if (ok) pushed++;
      }

      // ── Push pending deletes ──
      const pending = deps.store.getPendingDeletes();
      for (const row of pending) {
        await pushRowDelete(deps, session.token, row);
      }

      return { pulled, pushed, tombstoned };
    },

    async pushOne(spaceId) {
      const session = isProSession(deps);
      if (!session) return;
      const row = deps.db.prepare(
        "SELECT * FROM spaces WHERE id = ? AND deleted_at IS NULL",
      ).get(spaceId) as SpaceRow | undefined;
      if (!row) return;
      const dirtyAt = (row as { sync_dirty_at: number | null }).sync_dirty_at;
      const synced  = (row as { cloud_synced_at: number | null }).cloud_synced_at;
      // Clean if no dirty mark, or already synced past it.
      if (dirtyAt === null) return;
      if (synced !== null && synced >= dirtyAt) return;
      await pushRow(deps, session.token, row);
    },

    async pushDelete(spaceId) {
      const session = isProSession(deps);
      if (!session) return;
      // Read the local tombstone row (including deleted) so we know what
      // deleted_at to use if the worker says 404.
      const row = deps.db.prepare(
        "SELECT id, deleted_at, cloud_synced_at FROM spaces WHERE id = ?",
      ).get(spaceId) as { id: string; deleted_at: number | null; cloud_synced_at: number | null } | undefined;
      if (!row || row.deleted_at === null) return;
      await pushRowDelete(deps, session.token, row as unknown as SpaceRow);
    },
  };
}

async function pushRow(deps: SpaceSyncDeps, token: string, row: SpaceRow): Promise<boolean> {
  const dirtyAt = (row as { sync_dirty_at: number | null }).sync_dirty_at;
  if (dirtyAt === null) return false;  // shouldn't happen — caller filters

  let res: Response;
  try {
    res = await deps.fetch(`${deps.workerBase}/api/spaces/${encodeURIComponent(row.id)}`, {
      method: "PUT",
      headers: {
        Cookie: `oyster_session=${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        display_name:    row.display_name,
        color:           row.color,
        parent_id:       row.parent_id,
        summary_title:   row.summary_title,
        summary_content: row.summary_content,
        // Wire LWW key = sync_dirty_at (timestamp of the last sync-relevant
        // mutation), NOT the row's general-purpose updated_at.
        updated_at: dirtyAt,
      }),
    });
  } catch (err) {
    console.warn(`[spaces] push ${row.id} failed:`, err);
    return false;
  }

  if (res.status === 410) {
    // Cloud has tombstoned this row. Apply locally and stop dirty-retrying.
    deps.store.softDelete(row.id);
    return false;
  }
  if (!res.ok) {
    console.warn(`[spaces] push ${row.id} non-ok ${res.status}`);
    return false;
  }

  const body = await res.json().catch(() => null) as { space?: { updated_at?: number } } | null;
  const cloudUpdated = body?.space?.updated_at ?? dirtyAt;
  deps.store.markSynced(row.id, cloudUpdated);
  return true;
}

async function pushRowDelete(deps: SpaceSyncDeps, token: string, row: SpaceRow): Promise<void> {
  const localDeletedAt = (row as { deleted_at: number | null }).deleted_at ?? Date.now();
  let res: Response;
  try {
    res = await deps.fetch(
      `${deps.workerBase}/api/spaces/${encodeURIComponent(row.id)}`,
      { method: "DELETE", headers: { Cookie: `oyster_session=${token}` } },
    );
  } catch (err) {
    console.warn(`[spaces] delete ${row.id} failed:`, err);
    return;
  }

  if (res.status === 404) {
    // Cloud has no record — local tombstone is the only state; consider it
    // acknowledged so the pending-delete sweep stops re-trying.
    deps.store.markSynced(row.id, localDeletedAt);
    return;
  }
  if (!res.ok) {
    console.warn(`[spaces] delete ${row.id} non-ok ${res.status}`);
    return;
  }
  const body = await res.json().catch(() => null) as CloudDeleteResponse | null;
  const cloudDeletedAt = body?.deleted_at ?? localDeletedAt;
  deps.store.markSynced(row.id, cloudDeletedAt);
}
