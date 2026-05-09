# Oyster roadmap (2026-05 onwards; last edit 2026-05-09)

> **Status:** canonical. Each milestone is an epic that delivers one or more requirements from [`docs/requirements/oyster-cloud.md`](../requirements/oyster-cloud.md). If a ticket isn't on the path to making a requirement true, it doesn't belong on a milestone — it gets deferred or shipped opportunistically.
>
> **Anchor docs:**
> - [`docs/requirements/oyster-cloud.md`](../requirements/oyster-cloud.md) — pinned user outcomes (R1–R7).
> - [`docs/plans/0.5.0-gap-matrix.md`](./0.5.0-gap-matrix.md) — snapshot of where 0.5.0 stands against those outcomes.

## The spine

The free account tier is the **identity and publishing substrate**. Pro is the **sync, durability, and cross-device layer** on top.

Each milestone from here delivers one or more requirements. Polish, refactors, and clever local features may still happen — they ride on top of the spine, not in front of it.

## 0.6.0 — Trustworthy recall ✅ shipped

**Delivered:** R6 (traceable recall) + R2 same-device verbatim.

**Purpose:** make recall trustworthy *before* the heavier sync work scales it. Two tickets, shipped fast.

**Shipped:**

- ✅ **R6 traceable recall** (#310) — `memories.source_session_id` schema + watcher plumbing + `recall()` returns the originating session + inspector Memory tab renders "Pulled into / Written by this session" + Home memories list clicks through to the source session. Closes the loop: every recalled memory is traceable to the conversation that produced it.
- ✅ **R2 verbatim recall, same-device** (#311 / #328) — FTS5 over `session_events.text` plus `recall_transcripts` MCP tool. Cross-session spotlight (#331) added the in-transcript find experience. The cross-device extension lands in 0.8.0.

**Didn't ship:** anything else. Deferred items remain deferred.

## 0.7.0 — Free account + Publish/Share ✅ shipped

**Delivered:** R5 (publish & share artefacts) + the identity substrate that R1 / R5 / R7 ride on.

**Purpose:** first visible Cloud wedge — convert the waitlist into a free-account funnel and start making the pricing-page promise of *"Sync · Memory · Publish"* true.

**Shipped:**

- ✅ **Auth** — magic-link (#295) shipped first; **OAuth GitHub (#340) replaced it as the primary path**, magic-link demoted to fallback. Account state surfaced in-app.
- ✅ **R5 schema** (#314) — `share_token`, `share_mode`, `share_password_hash`, `published_at`, `share_updated_at`, `unpublished_at` columns on artefacts.
- ✅ **R5 backend** (#315) — `publish_artifact` / `unpublish_artifact` MCP tools, `POST /api/artifacts/:id/publish` + unpublish, cloud upload to R2 via `infra/oyster-publish` Worker.
- ✅ **R5 viewer** (#316) — public viewer at `share.oyster.to/p/<token>` with three access modes (open, password, sign-in-required). Origin-isolated from the main app (#397).
- ✅ **R5 UI** (#317) — Publish action in the artefact UI (modal, mode picker, URL display, copy-to-clipboard).
- ✅ **R5 hardening** (#400) — local-mirror backfill, cloud-only ghost rows, password=Pro gating, list-view context menu, cloud-only edit/rename/unpublish.
- ✅ **Entitlement / caps model** — free-tier caps for published-artefact size enforced in the Worker (10 MB ceiling); Pro tier unlocks higher.

## 0.7.1 — Spaces sync wedge ✅ shipped

**Delivered:** the first cross-device sync wedge — spaces metadata propagating across signed-in devices. Validated the DIY events-table + outbox + worker shape before extending to memory in 0.8.0.

**Shipped:**

- ✅ **Spaces sync** (#406, PR #407) — Pro users see the same set of spaces (name, hierarchy, summary) on every device. Published artefacts on a fresh device resolve to their real space instead of a generic "Cloud" bucket.
- ✅ **Boot banner refresh** — new logo + rotating tip per boot.

## 0.8.0 — Cross-device memory ✅ shipped

**Delivered:** R4 — memories travel with the user, not the device. Cross-agent recall (Claude / Cursor / Codex) works cross-device on the same Pro account.

**Purpose:** make the *"every agent, one shared brain"* tagline true across machines, not just across agents on one machine.

**Shipped:**

- ✅ **R4 cloud memory store** (#318) — `synced_memory_events` + `synced_memory_payloads` in D1, write-through outbox + cloud pull on focus/visibility/online/panel-mount/30s-poll, manual refresh button, profile-binding gate so account A's events don't pollute account B's local SQLite.
- ✅ **Live panel updates** (#421) — `memory_changed` SSE on cloud pulls and local writes, so the Memories panel re-fetches without focus.
- ✅ **Timezone-correct timestamps** (#422) — ISO-8601 UTC at the API boundary so non-UTC clients no longer render "ago" times skewed by their offset.

**Punted to 0.9.0** (originally scoped here, moved out for shipping speed):

- **Sync engine, broader** (#296) — beyond memory + spaces, the longer-tail surface. Memory-first stance from `archived/sync-direction.md` holds; transcripts intentionally cold-path.
- **R1 fresh-machine restore** (#319) — Home (memories + spaces) restores today; the missing piece is artefact-byte restore, which is R7-shaped.
- **R3 cold-storage transcripts** (#320) — durable backup of `session_events`, lazy-pulled by the inspector on first open per device.
- **R2 semantic recall** (#321) — embedding-backed recall, cross-device.
- **Pick up here** (#322) — cross-device session priming with summary + memories + artefact refs.

## 0.9.0 — Pro continuity (deepened) + multi-agent + R7

**Delivers:** the items punted from 0.8.0 (R1 / R2 / R3 / Pick-up-here / broader sync) plus R7 (artefact continuity across devices and across time) and native multi-agent ingestion beyond MCP memory.

**Purpose:** the hardest pieces, after the cloud substrate has soaked. Don't let any of these block earlier milestones.

**Ships:**

- **Sync engine, broader** (#296) — extends 0.8.0's memory + spaces sync to the longer tail.
- **R1 fresh-machine restore** (#319) — sign-in on a clean device populates Home from cloud end-to-end (memories + spaces shipped in 0.8.0; this finishes the artefact + transcript half).
- **R2 semantic recall** (#321) — embedding-backed recall, replaces / augments the OR-joined FTS for natural-language queries. Cross-device because vectors live in cloud.
- **R3 cold-storage transcripts** (#320) — durable backup of `session_events`, lazy-pulled by the inspector on first open per device. Survives machine loss.
- **Pick up here** (#322) — the killer demo. Cross-device session priming with summary + memories + artefact refs. Not a transcript replay — the agent is *primed*, not replayed.
- **R7 across-time** (#323) — `artifact_versions` table (or git-backed), snapshot-on-write, history view, diff between versions, revert. Local-first is acceptable; the across-time axis is independent of cross-device.
- **R7 across-device** (#324) — bidirectional artefact-byte sync with a defined conflict policy (LWW + version history is the leading candidate). The compound R7 scenario from the requirements doc passes end-to-end.
- **Multi-agent ingestion** (#298) — beyond MCP memory: native session ingestion for Cursor, Codex, OpenCode and beyond. Folds in #177 (closed).

## What's deferred (off-milestone, project-board priority Low)

These are real but off-spine. They get reopened to a milestone only if they earn it by serving a requirement:

- **#5** — error handling sweep. Defer in favour of feature-scoped error handling as each Cloud arc lands.
- **#309** — `origin_device_id` + `synced_at` schema. Speculative; the right column shapes depend on sync-engine design (0.8.0). Add when sync needs them.
- **#297** — headless mode. No requirement asks for headless; it's a deployment topology, not an outcome.
- **#313** — account-status / waitlist pill. Pricing-page conversion polish.
- **Bundles arc** (#242–#248) — multi-file static artefacts. Not required by R5 (single-file Publish suffices). Reopen to 0.9.0+ if R7 cross-device or multi-file Publish needs them.
- **Empty-state Home coach-mark** (#312) — first-time UX, not the R1 returning-user case. Reopen if onboarding becomes the bottleneck.
- **#249** — `local_process` MCP gap. Off-spine.
- **AI reorg primitives / views-as-queries** (#192, #193) — interesting, off-spine.
- **Live-system MCP connections** (#10), **background memory worker** (#100), **plugin tier 2/3** (#138, #137, #136, #135, #133, #179, #178), **older vision tickets** (#50, #51, #52, #53, #58, #60, #61, #62), **onboarding GUI review modal** (#190), **AI whisper** (#257), **spotlight unified search** (#264 — folded into R2 work in 0.8.0; standalone deferred), **topics** (#263).

## What's closed as superseded

- **#94, #186** — old portable-workspace / sync-export tickets, superseded by R1 + R3.
- **#11** — host Oyster over the internet, superseded by entitlement model + free account.
- **#12** — multi-user auth. Cloud is single-user multi-device; multi-user is out-of-scope.
- **#20** — agent sandbox / containerise OpenCode. Built on a cloud-multi-tenant runtime that's no longer the direction.
- **#176** — cross-agent provenance design fork, resolved by R4 + memory-first stance.
- **#177** — `register_agent` MCP tool, folds into #298.

## Decision principle

Before starting any work, check it against R1–R7. If it doesn't directly serve a requirement — *or* directly reduce the cost of serving one (cloud-readiness on a known dependency) — it doesn't belong on a milestone. Polish is fine; it just doesn't get a slot.

## How to update this doc

This is the *living* roadmap. Update sections as they ship — change "Delivers" to "Delivered in <version>" once a requirement is verifiably met, and leave the section in place as historical record. The deferred / closed lists at the bottom evolve as items get reopened or moved back into scope; mark them in place rather than deleting.
