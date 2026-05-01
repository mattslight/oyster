# Oyster roadmap (2026-05 onwards)

> **Status:** canonical. Supersedes the prior 0.5.1 / 0.5.2 / 0.6.0 / 0.7.0 / 0.8.0 framing.
>
> **Anchor docs:**
> - [`docs/requirements/oyster-cloud.md`](../requirements/oyster-cloud.md) — pinned user outcomes (R1–R7).
> - [`docs/plans/0.5.0-gap-matrix.md`](./0.5.0-gap-matrix.md) — snapshot of where 0.5.0 stands against those outcomes.

## The spine

The free account tier is the **identity and publishing substrate**. Pro is the **sync, durability, and cross-device layer** on top. Every release after 0.5.0 derives from this cleavage. Anything that doesn't directly serve R1–R7 is closed, deferred, or shipped opportunistically — not planned.

The earlier 0.6.0 (bundles polish), 0.7.0 (auth + sync + publish, all together), and 0.8.0 (multi-agent) framing has been superseded. Bundles is now part of cloud-readiness; auth+publish is its own visible wedge before the heavier sync work; full Pro continuity (sync + durability + semantic recall + pick-up-here) is its own arc; artefact-byte sync and versioning come last.

## 0.6.0 — Cloud-readiness primitives

**Purpose:** avoid building Cloud on bad local assumptions. Schema decisions that are free to make now, painful to retrofit later. The single primitive (bundles) needed to make Publish a real cloud-shaped feature when 0.7.0 lands.

**Ships:**

- Bundles / multi-file static artefacts (#242 + sub-issues #243–#248) — `runtime_kind=static_dir`, `ownership` column, reserve `storage_kind=object_store`, `/a/<id>/*` route, `push_artifact` MCP, file-level update/delete tools.
- Forward-compat schema columns: `origin_device_id` on sessions; `synced_at` on sessions / memories / artefacts / spaces; `source_session_id` on memories.
- FTS5 over `session_events.text` for verbatim transcript recall (R2 verbatim case, same-device).
- R6 traceable recall basics: populate `source_session_id` from the watcher; return it from `recall()`; clickthrough in the inspector Memory tab (#272).
- Error handling & resilience pass (#5).
- Empty-state Home affordance — replaces the dead-on-arrival fresh-install experience with a guided "connect your AI / add a folder" coach-mark.
- Account-status / waitlist indicator on the Pro pill — anyone who joined the waitlist sees acknowledgement in-app.

**Won't ship in 0.6.0:** new product surface beyond what's listed. No spotlight unified search, no topics, no AI whisper, no plugin work, no headless mode. 0.6.0 is correctness + primitives, not features.

## 0.7.0 — Free account + Publish/Share

**Purpose:** first visible Cloud wedge. Make the pricing page start to be true. Convert the waitlist into a free-account funnel.

**Ships:**

- Free account identity (magic-link sign-in). Account state surfaced in-app.
- Publish artefact (R5) — built on `push_artifact` from 0.6.0 — with three access modes: open / password-protected / sign-in-required (free Oyster account).
- Public viewer for published artefacts.
- Entitlement / caps model — free tier has caps (count, bandwidth); Pro tier unlocks higher caps. The substrate that all later Pro features ride on.

**Won't ship in 0.7.0:** sync, durability, cloud memory store, semantic recall, cross-device anything, artefact-byte sync, version history. Those are 0.8.0+.

The pricing page promise of "Sync · Memory · Publish" begins being delivered with **Publish**. Sync and Memory follow in 0.8.0.

## 0.8.0 — Pro continuity

**Purpose:** solve the empty-machine deadness. Make the *"sign in on a new laptop and your work is there"* promise true. Deliver R1, R3, R4 (cross-device), and R2's cross-device extension.

**Ships:**

- Cloud memory store + sync (memories travel with the user, not the device).
- Cloud session metadata + summaries (per-session summary on the cloud; metadata replicates).
- Semantic recall (embedding-backed, replaces / augments the OR-joined FTS for the natural-language case).
- Cross-device recall (R2 Pro extension — the same query works on any signed-in device).
- "Pick up here" — agent priming with summary + relevant memories on a non-origin device.
- Restore onto a fresh machine (R1 fully delivered).
- Cold-storage durable backup of session transcripts (R3 verify clause).

**Won't ship in 0.8.0:** artefact-byte sync, version history, diff/revert, cross-device artefact editing. R7 cross-device is its own arc.

## 0.9.0+ — Artefact continuity and multi-agent depth

**Purpose:** the harder pieces, after the Cloud substrate is steady-state. Don't let any of these block 0.6.0 / 0.7.0 / 0.8.0.

**Ships:**

- R7 across-time: artefact version history, diff, revert. Local-only is acceptable as a starting point — the across-time axis is independent of cross-device.
- R7 across-device: bidirectional artefact-byte sync. Conflict policy (last-write-wins / lock-on-edit / CRDT / explicit-merge — design-time decision, see R7 caveat in the gap matrix).
- Multi-agent ingestion beyond MCP memory (#298 + folded #177): native session ingestion for Cursor, Codex, OpenCode and beyond.
- Richer cross-agent session model.

## What's being cut or deferred

Everything else. Concrete actions:

**Close as superseded by Cloud direction** (link to [`docs/requirements/oyster-cloud.md`](../requirements/oyster-cloud.md)):

- #94, #186 — old portable-workspace / sync-export tickets.
- #11 — host Oyster over the internet (was P:Low, superseded by entitlement model + free-account substrate).
- #12 — multi-user auth / account isolation (Cloud is single-user multi-device; multi-user is out-of-scope per [`sync-direction.md`](./sync-direction.md)).
- #20 — agent sandbox / containerise OpenCode (built on cloud-multi-tenant-runtime assumption that's no longer the direction).
- #176 — cross-agent provenance design fork (resolved by R4 + memory-first stance).
- #177 — `register_agent` MCP tool (folds into #298).

**Defer indefinitely** (mark project board priority Low; don't close — these may be future work, just not on the spine):

- Plugin Tier 2/3 ecosystem: #138, #137, #136, #135, #133, #179, #178.
- AI reorg primitives / views-as-queries: #192, #193.
- Live-system MCP connections: #10.
- Background memory worker / proactive enrichment: #100.
- Older vision/idea tickets: #50, #51, #52, #53, #58, #60, #61, #62.
- Onboarding GUI review modal: #190.
- AI whisper / ambient intelligence: #257.
- Spotlight unified search (#264) — fold into R2 work in 0.8.0; standalone polish version is deferred.
- Topics (#263) — reorg primitive, deferred.

**Pull into 0.6.0 milestone:**

- #5 — Error handling & resilience (already P:High, no milestone today).
- #243–#248 — bundles arc (already 0.6.0, keep as the headline).
- #272 — Session inspector Memory tab (move from 0.5.1, bundle with `source_session_id` work).
- #249 — `local_process` MCP gap (only if cheap; otherwise punt).

**File new 0.6.0 issues** (these don't exist yet):

- Schema: `origin_device_id` on sessions; `synced_at` on sessions / memories / artefacts / spaces.
- Schema: `source_session_id` on memory rows + populate from watcher + return from `recall()`.
- FTS5 over `session_events.text` for verbatim transcript recall.
- Empty-state Home affordance (guided coach-mark when zero spaces / sessions / memories).
- Account-status / waitlist indicator on the Pro pill.

**Update existing tickets:**

- #294 (tracking Pro public release) — split: 0.7.0 = free account + publish only; 0.8.0 = Pro continuity (sync + recall + durability); 0.9.0+ = R7 cross-device.
- #295 (auth: magic-link) — pull forward into 0.7.0.
- #296 (sync engine) — move to 0.8.0; bring body in line with `sync-direction.md` (memory-first, not transcript hot-path); drop "live session handoff" / "session events stream" from in-scope.
- #297 (headless mode) — mark "no-go for 0.7.0 / 0.8.0" per its own scoping; revisit if a cloud-only persona becomes real.
- #298 (multi-agent ingestion) — move to 0.9.0+; fold #177 into it; close #177.

**Drop from 0.5.1 / 0.5.2 milestones** (close milestones; ship aligned ones opportunistically under 0.6.0, drop the rest):

- 0.5.1: #270, #271 (inspector tabs), #240, #239, #238, #237, #256, #281, #282, #284 — pick up if the work passes through; otherwise defer or close.
- 0.5.2: #263 (topics), #264 (spotlight) — deferred per cuts list.

## Decision principle

Before starting any work, check it against R1–R7. If it doesn't directly serve a requirement — *or* directly reduce the cost of serving one (cloud-readiness) — it doesn't belong on the roadmap. Polish, refactors, and clever local features may still happen, but they ride on top of the spine, not in front of it.

## How to update this doc

This is the *living* roadmap. Update sections as they ship — change status from "ships" to "shipped in <version>", add post-release learnings inline. When a version is fully delivered, leave its section in place as historical record rather than removing it. The cuts/deferrals list at the bottom evolves as items get reopened or moved back into scope; mark them in place rather than deleting.
