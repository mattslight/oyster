# Spaces sync — spin-out from #319

**Status:** Draft (2026-05-06). Brainstormed in session; awaits implementation plan.
**Tracks:** new ticket, R1 wedge, milestone 0.8.0. Dovetails with [#319](https://github.com/mattslight/oyster/issues/319).

## Goal

Cloud-mirror the `spaces` table so that on a fresh signed-in device, the user's spaces resolve correctly — pill labels, parent hierarchy, summary content. Resolves the `_cloud` fallback bug at `server/src/artifact-service.ts:220` where a published artefact's mirrored `space_id` can't be matched against any local row.

This is the **A1 wedge** of #319: the smallest piece that closes a real cross-device gap and establishes the architectural pattern for the rest of 0.8.0. Sources, repo paths, and the re-attach UX stay in #319.

## Architectural pattern (wedge scope only)

**This is the first small metadata-sync wedge. It is not yet the general Oyster sync architecture.** Before applying the same pattern to memory (#318), sessions, or artefact bytes (R7), run a dedicated build-vs-lease decision covering PowerSync, ElectricSQL, Replicache, and object-storage-only designs. The wedge is small enough that DIY is faster than a framework evaluation; the *second* resource type asking for the same plumbing is the inflection point where the question becomes load-bearing.

**Three different patterns are likely needed across 0.8.0+ resources** — do not assume one-size-fits-all sync:

| Resource type | Examples | Likely pattern |
|---|---|---|
| Metadata rows (small, mutable, structural) | spaces, publication records, settings | DIY row-level sync to D1 (this wedge) — or framework if many of these |
| Append-only / mergeable records | memories, session events, summaries | event log / append-only cloud store; merge-at-recall; not full row sync |
| Artefact bytes (large blobs) | HTML, markdown, decks, files | R2 object storage, fetch-on-open, lock-on-edit; do **not** build Dropbox |

The wedge below is pattern (1), scoped to spaces only. Other resource types deserve their own design conversation, not a copy-paste of this shape.

**Oyster is local-first by default, cloud-backed when signed in.** Two forced decisions:

1. **All Pro spaces sync.** On Pro upgrade, every existing local space is promoted to cloud — no per-space cloud-or-not flag. On a new-device sign-in, the user may optionally pick which subset of their cloud spaces to materialise locally; that selective-pull affordance is a future ticket (folds into #319's sign-in UX alongside re-attach). The wedge pulls everything.
2. **Local SQLite remains the immediate write target. Cloud is the cross-device source of truth.** Dirty-row reconciliation, last-write-wins by `updated_at`.

**Why no `sync_eligibility` flag?** A per-row "this space stays local forever" toggle is a privacy concept; the candidate use cases (privacy, embarrassment, storage cost, compliance) are either fringe or addressed by other levers. The better-shaped affordance is per-device selective subscription at sign-in (Dropbox model), which doesn't need a column on the canonical row — it's a sign-in choice about which cloud rows to materialise on this device.

The "cloud truth principle" memory has been refined accordingly — see `project_cloud_truth_principle.md`. The pre-existing read of "cloud is canonical, local is a cache" was directionally right but wrong about write order. Writes happen locally first; cloud catches up in the background.

## Out of scope

- **Sources / repo paths / re-attach UX** — owned by #319.
- **Realtime push** (websockets, Durable Objects) — sync is reconcile-on-trigger.
- **Selective sync at new-device sign-in** — the affordance to pick which cloud spaces to materialise locally on a fresh device. Folds naturally into #319's onboarding flow. The wedge pulls all cloud spaces unconditionally.
- **Memory sync (#318) and artefact byte sync (R7)** — same pattern, different tables, different specs.

## Data model

### Local SQLite — additive migration

Three new columns on `spaces` (additive `ALTER TABLE ... ADD COLUMN`, idempotent per project convention):

| Column | Type | Default | Purpose |
|---|---|---|---|
| `sync_dirty_at` | INTEGER (unix ms) | NULL | Timestamp of the last mutation to a *synced* field (display_name, color, parent_id, summary_title, summary_content). NULL = no sync-relevant changes since last push (or never). The dirty-row marker. |
| `cloud_synced_at` | INTEGER (unix ms) | NULL | Timestamp of the cloud row's `updated_at` from the last successful push. NULL = never synced. |
| `deleted_at` | INTEGER (unix ms) | NULL | Soft-delete tombstone; needed so deletions can propagate to cloud and out to peers. Replaces hard-delete in `space-service.deleteSpace()`. |

**Why a separate `sync_dirty_at` instead of using `updated_at`?** `spaces.updated_at` is bumped by every `space-store.update()` — including local-only fields like `scan_status` / `last_scanned_at` / `ai_job_status`. Using `updated_at` as the sync marker would push unchanged synced data after every scanner pass, and worse: a local scan could *win* an LWW race against a peer's legitimate rename (newer `updated_at` from a scan → cloud accepts the no-op write → peer's rename is overwritten). `sync_dirty_at` is bumped only by mutations that actually change synced fields.

**Dirty-row predicate (live rows):**
```sql
WHERE deleted_at IS NULL
  AND sync_dirty_at IS NOT NULL
  AND (cloud_synced_at IS NULL OR sync_dirty_at > cloud_synced_at)
```

**Pending-delete predicate (rows to push as DELETE):**
```sql
WHERE deleted_at IS NOT NULL
  AND (cloud_synced_at IS NULL OR deleted_at > cloud_synced_at)
```

Both predicates and timestamps are unix ms throughout (no `datetime('now')` text comparisons). When the user is signed out / on free tier, `reconcile()`, `pushOne()`, and `pushDelete()` all early-return without making network calls — sync columns stay NULL, harmlessly, until first Pro sign-in.

**Pro entitlement.** Per the requirements doc tier mapping, R1 (empty-machine continuity, which this wedge serves) is a Pro feature. The sync service explicitly checks `user.tier === "pro"` in addition to having a session token. Free / signed-out users do not push or pull.

### Cloud D1 — new table on the shared `oyster-auth` D1 database

The `oyster-publish` worker reads/writes the *same* D1 database as `oyster-auth` (binding name `DB`, database name `oyster-auth`, ID `44086805-...`) — that's how publish reads the `users` and `sessions` tables produced by the auth worker, and where `published_artifacts` already lives. Adding spaces to that same DB avoids a second database and lets the existing session-auth flow gate every endpoint identically.

**Migration files for that shared D1 live under `infra/auth-worker/migrations/`.** New migration: `infra/auth-worker/migrations/0006_synced_spaces.sql`. The endpoints are still served by the `oyster-publish` worker (`infra/oyster-publish/src/worker.ts`).

```sql
CREATE TABLE synced_spaces (
  owner_id        TEXT NOT NULL,
  space_id        TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  color           TEXT,
  parent_id       TEXT,
  summary_title   TEXT,
  summary_content TEXT,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,                  -- tombstone; row stays after delete
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (owner_id, space_id)
);

CREATE INDEX idx_synced_spaces_owner_updated
  ON synced_spaces (owner_id, updated_at DESC);
```

Tombstones (rather than DELETE FROM) are kept so that other devices can apply the deletion on next reconcile. They can be GC'd after, say, 30 days — out of scope for this ticket.

### Fields explicitly NOT in the cloud row

These stay device-local. Pushing them up would corrupt cross-device state.

| Local-only | Why |
|---|---|
| `scan_status`, `scan_error`, `last_scanned_at`, `last_scan_summary` | Scanner runs against a local filesystem path; status is per-device. |
| `ai_job_status`, `ai_job_error` | Per-device job state. |
| `sources.*`, `space_paths.*` | Filesystem paths are device-specific. Owned by #319. |

`space-store.update()` already filters via `UPDATABLE_COLUMNS`; we do not need to filter on the cloud-write side — only the synced columns are sent.

## Worker endpoints (`infra/oyster-publish/src/worker.ts`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/spaces/mine` | Returns this user's live + tombstoned `synced_spaces` rows (full pull). Response: `{spaces: SyncedSpace[]}` where `SyncedSpace` includes `deleted_at` (null or unix ms). Volumes are tens-to-hundreds of rows per user, so full pull is the right shape for the wedge. Incremental `?since` is a future optimisation if the row count materially grows. |
| `PUT`  | `/api/spaces/:id` | Upsert one row. Body: `{display_name, color, parent_id, summary_title, summary_content, updated_at}`. Worker COALESCEs missing fields (mirrors PATCH-style of #400). Last-write-wins by `updated_at` — server rejects writes with `updated_at <= existing.updated_at` and returns the existing row (200 with the existing data), so a stale write becomes a no-op rather than an error. **Resurrection rule:** PUT against a tombstoned row (`deleted_at IS NOT NULL`) returns `410 gone` so the client knows to apply the tombstone locally instead. Response: `{space: SyncedSpace}`. |
| `DELETE` | `/api/spaces/:id` | Sets `deleted_at = now()` and bumps `updated_at = now()` on the cloud row (so peers' next pull picks up the tombstone via the same updated_at gradient). Idempotent — re-DELETE returns the existing tombstone. Response: `{space_id, deleted_at, updated_at}`. |

Auth: session cookie (same as publish endpoints). `owner_id` derived from session, never trusted from request body.

## Server side — new `space-sync-service.ts`

Modelled on `publish-service.ts`. Single file, cohesive surface, called from `auth-service` (sign-in) and `space-service` (mutations).

**Surface:**

```ts
export interface SpaceSyncService {
  /** Pull cloud → local, then push local → cloud. Idempotent. Called on sign-in
   *  (from auth-service after backfillPublications) and on app start when
   *  signed in. Same shape as backfillPublications. */
  reconcile(): Promise<{ pulled: number; pushed: number; tombstoned: number }>;

  /** Fire-and-forget push for one row after a local mutation. Awaited only by
   *  tests; UI does not block. Single-row PUT to /api/spaces/:id. */
  pushOne(spaceId: string): Promise<void>;
}
```

**`reconcile()` algorithm:**

1. Pro gate: if no signed-in user, no session token, OR `user.tier !== "pro"`: return zeros (no network calls).
2. `GET /api/spaces/mine` → list of `{space_id, ...fields, updated_at, deleted_at}`.
3. For each cloud row:
   - If `deleted_at` is set: soft-delete locally **using `cloud.deleted_at` as the local `deleted_at` timestamp** (not `Date.now()` — preserves cross-device tombstone provenance). Set `cloud_synced_at = cloud.updated_at`. Skip down-sync of fields.
   - Else if no local row: insert. Set `cloud_synced_at = cloud.updated_at`.
   - Else if `local.sync_dirty_at IS NULL OR cloud.updated_at > local.sync_dirty_at`: cloud is the winner; update local synced fields, set `cloud_synced_at = cloud.updated_at`. (Don't touch `sync_dirty_at` — leave it where it was; the predicate naturally goes clean because `cloud_synced_at >= sync_dirty_at`.)
   - Else: local has newer unsynced changes; defer to step 4.
4. Find dirty local rows (live, dirty predicate above) and `PUT /api/spaces/:id` for each. Wire `updated_at = local.sync_dirty_at`. On 200, set `cloud_synced_at = response.space.updated_at`.
5. Find pending deletes (deleted-row predicate above) and `DELETE /api/spaces/:id` for each. On 200, set `cloud_synced_at = response.deleted_at`. On 404 (already gone elsewhere), set `cloud_synced_at = local.deleted_at` so the row stops being treated as pending.
6. Return counts for logging.

**`pushOne(spaceId)`** — Pro gate, checks the row is dirty + live, PUTs it (wire `updated_at = sync_dirty_at`), updates `cloud_synced_at`. Swallows network errors with a `console.warn`; the next `reconcile()` will retry.

**`pushDelete(spaceId)`** — Pro gate, DELETEs the cloud row. On 200, mark synced. On 404, treat the local tombstone as already acknowledged. Network errors swallow; pending-delete sweep in `reconcile()` retries.

**Wiring:**

- `auth-service.ts` on sign-in, run in this order:
  1. `spaceSync.reconcile()`
  2. `backfillPublications()`
  3. render Home

  The headline fix of this ticket is precisely that published-artefact ghosts resolve to real spaces, not `_cloud`. Doing publications first defeats that — the ghost rendering would still fall through to `_cloud` until the *next* sign-in. Spaces first → publications second → render is what makes the fix immediate.
- `space-service.ts` after every `update()` / `insert()` / `delete()`: call `spaceSync.pushOne()` (fire-and-forget).
- App start (when already signed in, e.g. server restart): call `reconcile()` then `backfillPublications()`.

## Promotion act (first Pro sign-in)

The migration adds `sync_dirty_at` defaulting to NULL — i.e. existing rows are *not* automatically dirty. We need a one-time backfill so the first `reconcile()` actually pushes existing data up. Two acceptable shapes:

- **Migration-time backfill:** the same `db.ts` block that adds `sync_dirty_at` immediately runs `UPDATE spaces SET sync_dirty_at = strftime('%s','now') * 1000 WHERE sync_dirty_at IS NULL` so every existing row is marked dirty exactly once.
- **First-Pro-sign-in backfill:** in the sync service, on first invocation when the user is Pro, run the same UPDATE if `cloud_synced_at IS NULL` rows exist that haven't been seen by sync before.

Migration-time is simpler and cheaper — pick that. After the backfill, the dirty predicate fires for every existing row on the next `reconcile()`. The migration *is* the promotion mechanism, plus one line of UPDATE.

## Resolves `_cloud` fallback

Today, `artifact-service.ts:220` does:

```ts
const spaceId = pub.spaceId && localSpaceIds.has(pub.spaceId) ? pub.spaceId : "_cloud";
```

After this ticket, on a fresh device, the first `reconcile()` after sign-in populates `localSpaceIds`. Subsequent ghost rendering resolves to the real space. No change to artifact-service is needed for the wedge — the fix happens upstream when the spaces are present.

## Acceptance criteria

**Cross-device ground truth:**

- [ ] Sign in as Pro on Machine A with N existing local spaces. Inspect cloud (D1) — N rows present.
- [ ] Rename a space on Machine A. Wait. Sign in on Machine B. Space appears with new name.
- [ ] Create a space on Machine A. Sign in on Machine B. Space appears.
- [ ] Delete a space on Machine A. Sign in on Machine B. Space is soft-deleted locally (and hidden from UI).
- [ ] Publish an artefact on Machine A in space "Work". Sign in on Machine B. Published-artefact ghost resolves to "Work" (not `_cloud`). **This is the headline fix.**

**Local-first / offline:**

- [ ] Free user / signed-out: no cloud writes; local spaces work as before.
- [ ] Pro user offline: local mutations apply instantly. On reconnect + next reconcile, dirty rows push up.

**Idempotence:**

- [ ] Run `reconcile()` twice in a row with no mutations between: second call reports `pulled: 0, pushed: 0`.
- [ ] Re-running migration on already-migrated DB: no-op (try/catch on ALTER per project convention).

## Edge cases & known limits

- **Concurrent rename, two devices.** Last-write-wins by `updated_at`. The losing device sees the winning name on next `reconcile()` (mutation, sign-in, or app start). Acceptable for spaces — they're not chatty.
- **Tombstone before peer sync.** Device A deletes space X. Device B is offline, has a pending dirty rename for X. When B comes online, B's `pushOne()` PUTs to the tombstoned cloud row and gets `410 gone`. B's service handler treats `410` as a signal to soft-delete the local row and stop dirty-re-trying. Net behaviour: deletion wins over a stale rename. The next `reconcile()` pull confirms the tombstone idempotently.
- **Free-tier sign-out after Pro use.** If a user downgrades or signs out, `currentUser()` returns null and `reconcile()` early-returns. Local SQLite continues to work. Cloud rows stay until the user re-signs-in or explicitly clears. (Out of scope to handle downgrade-time tombstoning.)
- **`parent_id` referential integrity.** Cloud doesn't enforce FK on parent. Possible (rare) state: parent space tombstoned but child still references it. Surface treats orphaned parent_id as null (existing behaviour for missing parents in space-store).
- **Tombstone GC.** Out of scope; tombstones grow forever in this iteration. Realistic at expected volumes (tens of spaces per user).

## Sequencing / build order

1. Worker migration `0006_spaces.sql` + endpoints in `worker.ts` + helpers in `publish-helpers.ts`. Deploy to dev environment.
2. Local migration: ALTER TABLE adds the three columns. `db.ts`.
3. `space-sync-service.ts` with `reconcile()` + `pushOne()`.
4. Wire into `auth-service` (sign-in) and `space-service` (mutations).
5. Replace hard-delete in `space-store.delete()` with soft-delete (`deleted_at`); update queries that read live spaces (`getAll`, `getById`, etc.) to filter `WHERE deleted_at IS NULL`.
6. Tests: unit + cross-device acceptance test (two SQLite instances + worker).
7. CHANGELOG entry under **Changed**: *"Spaces now sync across signed-in devices for Pro users."* (Per `feedback_changelog_style` — outcome, not internals.)

## Dependencies

- **#400** (R5 hardening) — done. Provides the worker shape this ticket extends.
- Auth (#295) — done. Session cookie wiring already used by publish.
- No blockers.

## Hand-off to #319

Once this ticket is in:

- `localSpaceIds` is populated cross-device → `_cloud` fallback resolves naturally.
- #319 picks up sources / repo paths / re-attach UX as a coherent unit.
- #319's "tell the user which spaces have a `repo_path` so they can clone or re-attach" verify clause depends on this ticket having shipped — without it, the user wouldn't see their spaces on Machine B at all.

## Sub-spec / unresolved

- **Endpoint placement.** Default plan is to put endpoints in the `oyster-publish` worker. If naming feels wrong long-term, a rename to `oyster-cloud` (single multi-resource worker) can happen out of band — not gating.
- **Selective per-device sync at new-device sign-in.** A user signing in on a fresh device may want to pick a subset of their cloud spaces to materialise locally (Dropbox-style selective sync). This is sign-in UX, not a property of the canonical row. Folds into #319's onboarding flow. Out of scope for this wedge — wedge pulls everything.
