# Oyster roadmap (2026-05 onwards)

> **Status:** canonical. Each milestone is an epic that delivers one or more requirements from [`docs/requirements/oyster-cloud.md`](../requirements/oyster-cloud.md). If a ticket isn't on the path to making a requirement true, it doesn't belong on a milestone — it gets deferred or shipped opportunistically.
>
> **Anchor docs:**
> - [`docs/requirements/oyster-cloud.md`](../requirements/oyster-cloud.md) — pinned user outcomes (R1–R7).
> - [`docs/plans/0.5.0-gap-matrix.md`](./0.5.0-gap-matrix.md) — snapshot of where 0.5.0 stands against those outcomes.

## The spine

The free account tier is the **identity and publishing substrate**. Pro is the **sync, durability, and cross-device layer** on top.

Each milestone from here is a single requirement (or pair) being made true. Polish, refactors, and clever local features may still happen — they ride on top of the spine, not in front of it.

## 0.6.0 — Trustworthy recall

**Delivers:** R6 (traceable recall) + R2 same-device verbatim.

**Purpose:** make recall trustworthy *before* the heavier sync work scales it. Two tickets, ships fast.

**Ships:**

- **R6 traceable recall** (#310) — `memories.source_session_id` schema + watcher plumbing + `recall()` returns the originating session + inspector Memory tab renders "Pulled into / Written by this session" + Home memories list clicks through to the source session. Closes the loop: every recalled memory is traceable to the conversation that produced it.
- **R2 verbatim recall, same-device** (#311) — FTS5 over `session_events.text` so the *"what FTS5 schema did we settle on?"* / *"what were the exact specs we agreed for the render server?"* case resolves locally. The cross-device extension lands in 0.8.0.

**Won't ship:** anything else. No bundles, no empty-state coach-mark, no waitlist pill, no broad error-handling sweep, no schema speculation for sync. Those were on prior drafts of this milestone — all deferred to where they actually deliver value.

## 0.7.0 — Free account + Publish/Share

**Delivers:** R5 (publish & share artefacts) + the identity substrate that R1 / R5 / R7 ride on.

**Purpose:** first visible Cloud wedge. Convert the waitlist into a free-account funnel. The pricing page promise of *"Sync · Memory · Publish"* starts being true with **Publish**.

**Ships:**

- **Magic-link auth** (#295) — sign-up + sign-in. Account state surfaced in-app. Pattern from `~/Dev/oyster-crm`.
- **R5 schema** (#314) — `share_token`, `share_mode`, `share_password_hash`, `published_at`, `unpublished_at` columns on artefacts.
- **R5 backend** (#315) — `publish_artifact` MCP tool, `POST /api/artifacts/:id/publish`, cloud upload to R2 object store.
- **R5 viewer** (#316) — public route at `/s/<share_token>` with three access modes (open, password, sign-in-required).
- **R5 UI** (#317) — Publish action in the artefact UI (modal, mode picker, URL display, copy-to-clipboard).
- **Entitlement / caps model** — free tier caps (artefact count, bandwidth); Pro tier unlocks higher caps. The substrate that all later Pro features ride on. Folds into the work above; not a separate ticket unless it grows.

**Won't ship:** sync, durability, cloud memory store, semantic recall, cross-device anything, artefact-byte sync, version history. Those are 0.8.0+. Multi-file bundles also out of scope — single-file artefacts are sufficient for R5; richer Publish lives in 0.9.0+ if it earns its keep.

## 0.8.0 — Pro continuity

**Delivers:** R1 (empty-machine continuity) + R3 (durability) + R4 cross-device + R2 cross-device extension.

**Purpose:** solve the empty-machine deadness. *Sign in on a new laptop and your work is there.*

**Ships:**

- **Sync engine** (#296) — memory-first transport, end-to-end encrypted. Per `archived/sync-direction.md` framing: hot path = memories + spaces + artefact manifests + session metadata + summaries; cold path = transcripts.
- **R4 cloud memory store** (#318) — memories travel with the user, not the device. Cross-agent recall (Claude / Cursor / Codex) works cross-device.
- **R1 fresh-machine restore** (#319) — sign-in on a clean device populates Home from cloud, no manual setup.
- **R3 cold-storage transcripts** (#320) — durable backup of `session_events`, lazy-pulled by the inspector on first open per device. Survives machine loss.
- **R2 semantic recall** (#321) — embedding-backed recall, replaces / augments the OR-joined FTS for natural-language queries. Cross-device because vectors live in cloud.
- **Pick up here** (#322) — the killer demo. Cross-device session priming with summary + memories + artefact refs. Not a transcript replay — the agent is *primed*, not replayed.

**Won't ship:** artefact-byte sync, version history, diff/revert, cross-device artefact editing. R7 is its own arc.

## 0.9.0 — Artefact continuity + multi-agent depth

**Delivers:** R7 (artefact continuity across devices and across time) + R4 deepening (native multi-agent ingestion beyond MCP memory).

**Purpose:** the hardest pieces, after the Cloud substrate is steady-state. Don't let any of these block 0.6.0 / 0.7.0 / 0.8.0.

**Ships:**

- **R7 across-time** (#323) — `artifact_versions` table (or git-backed), snapshot-on-write, history view, diff between versions, revert. Local-first is acceptable; the across-time axis is independent of cross-device. Ship first to prove the version-store choice.
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
