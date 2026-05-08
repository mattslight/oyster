# Memory Sync — Architectural Decision Spec (#318)

**Status:** Decision spec. Not an implementation plan. No file paths, no migrations, no build steps.
**Date:** 2026-05-08
**Scope:** Cloud sync for the Oyster memory store. First milestone of 0.8.0 cross-device work after the spaces-sync wedge.

---

## Context

PR #407 (squash `03e765b`) shipped the first cross-device metadata-sync wedge — `spaces` table replicated to D1 for Pro users — and went out as 0.7.1-beta.0. **Implementation shipped to beta; cross-device verification still pending Task 11 on the second machine.** The wedge is not yet "the R1 cross-device promise works"; it is "the first row-sync substrate exists and one-way push verifies cleanly."

#318 is the next sync resource. Picking it up surfaces the question recorded in `project_sync_build_vs_lease.md`: with a second resource type asking for cross-device plumbing, do we DIY again or lease (PowerSync, ElectricSQL, Replicache, etc.)?

This spec answers that — but reframes the question first.

## The reframing

The right framing is not **build vs lease**. It is **classify Oyster data types before choosing sync machinery**.

Oyster has at least five distinct resource classes, each with a different natural sync shape:

| Class | Examples | Natural sync shape |
|---|---|---|
| Small mutable metadata | spaces, settings, publication rows | DIY row sync (what #407 ships) |
| Append-only semantic records | memories, session summaries, events | Append-only event log |
| Device-local attachment state | sources, repo paths, local folders | Cloud stores intent; device stores path |
| Large artefact bytes | markdown, html, decks, files | R2 object storage; fetch-on-open |
| Collaborative editable documents | (not yet, only if real-time co-editing emerges) | Yjs/Automerge/Loro |

#407 establishes that small mutable metadata row sync is viable. **It does not establish Oyster's general sync architecture.** Memories are class 2, not class 1. The right machinery is different.

## Decisions

### Q1 — Memory mutability

**Decision:** Memory cloud sync is not row sync. It is an append-only memory event log, paired with a redactable content store.

- `remember` writes a `memory_created` event and a corresponding payload row carrying the content.
- `forget` writes a `memory_forgotten` event. Payload is unchanged.
- Edit is not supported as a primitive. A correction is modelled as forgetting the old memory and creating a new one.
- The only synced operations are `memory_created`, `memory_forgotten`, and `memory_purged`. Device-local telemetry — `access_count`, recall timestamps, local ranking state — is excluded from cloud sync.
- Append-only applies to **event metadata**. Memory **content** lives in a separate redactable store (see Q6) so that purge can physically remove content without rewriting the event log.

**Footguns:**
- Do not sync `access_count` or recall telemetry. Device-local.
- Do not sync `updated_at` as meaningful memory state. It would create false conflicts.
- Use UUIDs for memory IDs. Creates never collide.
- Forgetting is a tombstone event, not a hard delete.
- Tombstones must sync before (or alongside) recall, otherwise forgotten memories can reappear on another device.
- Do not introduce edit affordances casually. If an agent says "I'll update that memory," internally that must mean forget old + remember new.
- Forget is global for Pro/cloud memories — not local-only.

### Q2 — Delete vs edit semantics

**Decision:** Memory forget and memory purge are separate intents. Forget writes a tombstone so the memory no longer participates in recall. Purge physically removes or redacts the stored content and is reserved for delete-forever, secret-exposure, and account-deletion flows. Restore is not supported; bringing a memory back creates a new memory.

- `remember` → `memory_created`
- `forget` → `memory_forgotten`
- Purge → `memory_purged` (or equivalent: `purged_at` set, content NULL)
- Restore → not supported

**Footguns:**
- Forget retaining original content forever in cloud is a trust footgun, especially for accidentally-captured secrets. Purge must exist from v1, even if the UI is minimal.
- Purge does not need to be an everyday MCP affordance in v1. Reserve it for: "delete forever" UI, account deletion, secret/PII panic path. Possibly not exposed via MCP at all in the first cut.
- This is the load-bearing reason the cloud store is **D1**, not R2 jsonl/KV. Targeted redaction is awkward in append-only blob storage; D1 supports it cleanly.
- **Account deletion** purges all cloud memory payloads and removes or redacts all memory events belonging to the `owner_id`. Forget and per-memory purge are not sufficient for full account-deletion semantics; account deletion is its own destructive operation that must clear payloads and (where possible) collapse event metadata.

### Q3 — Scope of memory ownership

**Decision:** Cloud memories are owned by the user. `space_id` is optional metadata used for recall scoping, not a storage boundary. Memory sync stores events unconditionally even when the referenced space is not yet present locally; the space relationship is soft and must not require FK ordering across sync streams.

- One cloud memory stream/table per user. `space_id` rides along as a tag.
- Global memories: `space_id IS NULL`.
- Space-scoped memories: `space_id` set.
- Recall in a space: returns global + matching `space_id` (already true today).
- Memory storage is **not** split per space. That would prematurely optimise for shared/team spaces, which are not on the roadmap.

**Footguns:**
- `space_id` must be the stable space ID from spaces sync. Never use display name.
- Unknown space IDs must render gracefully — show "Unknown space," bare ID, or hide the label until spaces sync catches up. Do not crash, do not drop the memory.
- Do not enforce a hard FK between memories and spaces, locally or in cloud. Independent stream ordering would become painful.
- Purging a space does **not** automatically purge memories. Space deletion and memory deletion are separate intents; a space-scoped memory can become orphaned but still exist unless explicitly forgotten/purged.
- Future shared spaces are out of scope. User-level bucket does not preclude sharing later, but shared-space memory would need a separate ownership model designed at that time.

### Q4 — Recall execution location

**Decision:** Keyword recall remains local-only for #318. Every Pro device maintains a full local SQLite materialised view of the user's active memories, built by replaying cloud memory events. Cloud D1 is the durable sync/event source, not the recall query path. Free and Pro users share the same recall implementation; Pro adds background event push/pull.

- Cloud D1 = durable event log.
- Local SQLite = materialised recall surface.
- Free user recall = local SQLite only.
- Pro user recall = local SQLite + background cloud sync.
- Offline recall continues to work.

**Invariant:** A device must replay cloud memory events into local SQLite before those memories participate in recall.

**First-sync UX is deferred to the implementation plan.** The decision spec only commits to the invariant. Implementation may pick blocking ("Syncing memories…") or non-blocking (recall returns partial results during sync). Lean: non-blocking with a visible "syncing memories" indicator.

### Q5 — Semantic / vector search

**Decision:** #318 does not introduce semantic or vector recall. Existing keyword recall remains local-only via SQLite FTS5, backed by a full local materialised view of cloud memory events. The append + tombstone event substrate should remain compatible with a future local vector index or a future cloud semantic index, but neither is part of #318.

The Q4 invariant is recorded as **"keyword recall is local-only"** — not "all recall is local-only" — to preserve flexibility for either future direction without relitigating this spec.

**Footguns:**
- Forget/purge must invalidate any future semantic index. Even though semantic is out of scope, the event model already makes this trivial: a future semantic index is downstream of events; a `memory_forgotten` or `memory_purged` event invalidates the corresponding entry on every device that materialises it.

Semantic search has its own decisions (embedding model location, index storage, embedding sync, privacy, cost, latency, offline behaviour, embedding invalidation after forget/purge). None of those are settled here. They are out of scope.

### Q6 — Eventual consistency

**Decision:** Memory events propagate with eventual consistency via a local event outbox flushed in the background. Each event has a stable client-generated `event_id` and cloud ingestion is idempotent. Out-of-order delivery is acceptable: forget and purge tombstones may arrive before creates and are applied unconditionally. Replay uses deterministic precedence: purge wins over forget, forget wins over create. The model is commutative and does not require causal ordering, vector clocks, or row-level conflict resolution.

**Outbox model:** the local event table doubles as the outbox. No separate `pending_memory_events` table. Event metadata and memory content live in **two distinct tables** so that purge can redact content without rewriting the event log.

```
-- Append-only event metadata
memory_events (
  event_id        TEXT PRIMARY KEY,
  memory_id       TEXT NOT NULL,
  event_type      TEXT NOT NULL,        -- created | forgotten | purged
  space_id        TEXT,                 -- only meaningful when event_type = 'created'
  created_at      INTEGER NOT NULL,
  cloud_synced_at INTEGER                -- NULL = pending push
)

-- Redactable content keyed by memory_id
memory_payloads (
  memory_id  TEXT PRIMARY KEY,
  content    TEXT,                       -- NULL after purge
  purged_at  INTEGER                     -- non-NULL after purge
)
```

Dirty predicate (events): `WHERE cloud_synced_at IS NULL`. Payload upserts ride alongside their corresponding event push (created → upsert payload row; purged → null content + set purged_at).

**Cloud constraints:**
- `UNIQUE(owner_id, event_id)`
- `UNIQUE(owner_id, memory_id) WHERE event_type = 'memory_created'`
- `UNIQUE(owner_id, memory_id) WHERE event_type = 'memory_forgotten'`
- `UNIQUE(owner_id, memory_id) WHERE event_type = 'memory_purged'`

Per-type uniqueness keeps the event log clean — a memory can be created at most once, forgotten at most once, purged at most once. Replay remains idempotent by `(memory_id, event_type)` semantics; duplicate forget/purge attempts are no-ops.

### Q7 — Conflict model

**Decision:** #318 has no conflict-resolution layer. The append + tombstone event model is commutative when materialised by `memory_id` using the precedence rule **purged > forgotten > created**. Precedence is time-independent, so clock skew cannot choose a winner. Cloud uniqueness constraints prevent duplicate ingestion. No LWW, no vector clocks, no merge function, and no conflict UI are required.

**Materialisation rule:** for each `memory_id`, the recall surface reflects the highest-precedence event seen.

**Footguns:**
- **Late create after purge must not restore content.** If `memory_purged(m1)` arrives before `memory_created(m1)` and its payload, both the create event and any payload upsert must be filtered against the purge: the event lands in the log, but the payload row stays at `content = NULL`, `purged_at` set. Purge dominates regardless of arrival order.
- **Purge physically redacts content.** A purged memory has `content = NULL` and `purged_at` set in the payload store. The event log may retain the `memory_purged` event as non-content audit metadata, but **purged content must be removed or nulled from all cloud and local storage**. There must not be a dormant copy of the original content anywhere after purge replays — not in event rows, not in payload rows, not in caches.
- **Cloud and local replay must use the same precedence rule.** Otherwise one device may recall something another has suppressed.
- **Event log and materialised view are distinct concerns.** `memory_events` = append-only metadata log. `memory_payloads` = redactable content store. `memories` (or `memory_view`) = current recall surface materialised from both. Implementation must not conflate the three.

## Framework verdict

Given the decisions above:

| Approach | Verdict for #318 |
|---|---|
| **DIY D1 event table** | **Chosen.** Append + tombstone fits trivially; purge needs targeted redaction (rules out blob stores); cost is a Worker route, a D1 table, and an outbox flush loop. |
| **PowerSync** | Rejected. Postgres ↔ SQLite row sync is the wrong machine for an append-only event log. Adopting it would require Oyster to move sync-canonical data to Postgres/Supabase/Neon — a much larger commitment than #318 warrants. |
| **ElectricSQL** | Rejected. Same shape as PowerSync; less mature; same misfit for append-only. |
| **Replicache / Reflect** | Rejected. Powerful, but reshapes the app model around mutators/pull/push for a problem that does not need it. |
| **Yjs / Automerge / Loro** | Rejected. Wrong layer. CRDT primitives are for collaborative editable documents (class 5), not append-only events. |
| **R2 jsonl / KV** | Rejected. Targeted purge/redaction is awkward in blob storage; rewriting jsonl files for one-row deletion is the wrong primitive. |

PowerSync/Electric/Replicache become relevant only if Oyster decides it needs broad bidirectional SQL replication. **#318 does not look like that.**

## Out of scope (explicitly)

- Mutable memory rows / `update_memory` MCP tool
- Restore / un-forget event type
- Causal ordering, vector clocks, LWW timestamps
- Row-level conflict resolution or conflict UI
- Cloud-side semantic / vector search
- Per-space memory ownership or shared-space memory
- Hard FK between memories and spaces (in either direction)
- Cascade behaviour from space deletion to memory deletion

## Deferred to the implementation plan

- First-sync UX (blocking vs non-blocking; lean: non-blocking with indicator)
- Outbox flush cadence and retry strategy
- Worker-side Pro tier gate enforcement on the ingestion endpoint (mirrors the spaces-sync follow-up noted in PR #407)
- Backfill of existing local memories at first Pro sign-in (treat each as a `memory_created` event with original `created_at`)
- Quotas / retention policy for the cloud event log
- Whether `memory_purged` ever surfaces via MCP, or remains UI-only and account-deletion-only
- Inspector / settings UI for managing synced memories

## References

- `docs/superpowers/specs/2026-05-06-spaces-sync-spinout-design.md` — the wedge that established small-mutable-metadata row sync.
- `docs/superpowers/plans/2026-05-06-spaces-sync-spinout.md` — the implementation pattern that does **not** generalise to memories.
- `docs/requirements/oyster-cloud.md` — R1, R2, R3, R4, R7 outcomes that ground every architectural choice.
- `docs/plans/sync-direction.md` — the "memory-first, not transcript sync" pivot.
- GitHub: #318 (memory store), #319 (R1 broader), #322 (Pick up here), #294 (Pro multi-release tracker).
