# Oyster onboarding + ongoing adds — PRD

**Date:** 2026-04-22 (revised after UAT of agent-led audit vs algorithmic pipeline)
**Status:** Approved direction. Implementation details deferred to build-as-we-go.
**Related:** Epic A (#184), `docs/superpowers/specs/2026-04-21-onboarding-mcp-first-design.md`, `docs/superpowers/notes/2026-04-22-chunk-3-comparison.md`

## Why this exists

Early design assumed Oyster could classify and group filesystem contents itself (marker-matching + LLM grouping). UAT showed this is the wrong job for Oyster: the user's agent — whether external (Claude Code, Cursor, Hermes) or embedded (Oyster's OpenCode subprocess) — produces substantially better proposals because it has shell access, git history, READMEs, and conversational context we don't. Oyster's algorithmic approach hit silent drops, narrow audience (code-only), and missed semantic judgements like *"graphiti is upstream tracking, not owned"*.

The product shape that falls out of this:

- **Oyster provides the workspace substrate** — primitives to create/extend spaces, a review surface, live progress rendering.
- **The agent provides the intelligence** — audits the filesystem, groups projects, names spaces, flags noise.
- **Drag-drop and agent-led aren't two flows.** They're two invocations of the same pipeline, where drag-drop uses OpenCode as the fallback agent.

## Two moments, not one

Setup and ongoing adds have different UX because they're different jobs.

### First-run / re-onboarding (the slow, thorough one)

**When:** first install. Or when the user explicitly says "audit everything again".

**Shape:** agent audits the user's machine (broad sweep — `~/Dev`, `~/Documents`, `~/Projects`, etc., cross-OS), reads git activity / READMEs for context, proposes a set of spaces with rationale, Oyster renders the proposal in a review UI, user confirms/tweaks, apply. Takes minutes.

**Principle — "no black holes":** the audit must be visible as it happens. Every shell call, every project found, every decision made is streamed to the user's screen. The UX is watching a thing happen, not waiting for a thing to finish. The user sees *"found `~/Dev/blunderfixer` (real project, active) ... found `~/Documents/Obsidian Vault` (notes) ... filtering `~/Documents/Zoom` (app data)"* in real time. No silence. No blank screen for 2 minutes. This is the value prop made visible.

**Agent source:** user's external agent if connected; Oyster's embedded OpenCode subprocess otherwise. Same interface either way. User doesn't have to connect anything before first-run — OpenCode is always available.

**Open UX question (decide via mock + UAT):** does the setup flow block the desktop ("welcome, setting up…"), or run inline with a live activity dock? Possibly the former on a true first-run (nothing to show on a fresh desktop anyway), and the latter for a re-audit. Don't commit to a design until we see it.

### Ongoing adds (the fast, scoped one)

**When:** after onboarding, user has a new project. Drags the folder onto the desktop, or asks the agent *"add ~/NewProject to Oyster"*.

**Shape:** single folder, scoped. If it's a project (has markers), one space. If it's a container (rare post-onboarding), OpenCode proposes and the user confirms. No full-machine audit. Seconds, not minutes.

## Principles

- **Oyster is the substrate, not the intelligence.** We don't classify; the agent does. We provide primitives and render proposals.
- **No black holes.** Anything that takes more than a few seconds shows live progress. Silence is a bug.
- **Everything visible.** Proposals include what's being imported, what's being excluded (with reason), and *"anything missing?"* — no hidden buckets, no silent drops.
- **Ask, don't audit.** Defense against errors is the user seeing the proposal and fixing it, not hidden recovery logic.
- **Recovery stays open.** Post-apply, the user can drag, click, or ask the agent to add anything we missed.

## Entry points

All produce the same proposal → review → apply pipeline.

- **First-run:** Oyster opens, prompts *"Let's look at your machine"* (or agent-initiated).
- **"Audit again" on the dock:** user triggers a fresh sweep.
- **Drag-drop a folder:** scoped add (via OpenCode if needed).
- **Agent: *"Set up Oyster"* or *"Add ~/foo"*:** same as the above, initiated from the agent side.

## Tools Oyster provides (atomic primitives)

- `list_spaces` — current state (exists)
- `list_artifacts(space_id)` — what's in a space (exists)
- `get_context` — explains the flow to the agent (exists; playbook rewrites per this PRD)
- `onboard_space(name, paths[])` — atomic: create/extend one space with one or more paths, scan each (exists; may need to accept an array of paths instead of one)
- `propose_spaces(plan)` — **new** — hands a plan to Oyster; Oyster renders the review UI; user confirms/tweaks; Oyster applies
- Progress stream (SSE) — exists (`/api/ui/events`), repurposed to carry agent activity during audits

## Tools to retire

- `discover_container` — Oyster shouldn't do discovery
- `onboard_container` — same, replaced by `propose_spaces` + `onboard_space`
- `discoverCandidates`, `groupWithLLM`, `discoverAllSubfolders`, `groupWithLLMRich` (in `discovery.ts`) — Oyster-owned classifiers, no longer used
- `/api/discover` and `/api/discover/import` may simplify or go entirely, depending on how drag-drop wires into the new pipeline

## Verification

A fresh install should pass all of these:

- Open Oyster for the first time → user sees *"let's look at your machine"* and watches the agent discover projects live → review modal with proposals → confirm → desktop populates with spaces.
- Any silent stretch longer than a few seconds is a bug.
- Drag a new folder onto a running Oyster → scoped add → new space or added to existing, within seconds.
- *"Set up Oyster for me"* from Claude Code (no manual path) → same flow as first-run, same review UI.
- The `blunderfixer`-silent-drop case becomes structurally impossible: the agent's audit names every project it finds; nothing is dropped; if the user disagrees they see it in review and fix it.

## Out of scope

- Broader artifact-detection changes (what counts as an app / deck / etc. *inside* a project).
- Memories, sync, or other non-discovery work.
- Multi-user / collaborative review of a proposal.

## What we keep from the branch so far

- Bug fix to `onboard_container` (chunk 1, `7cd2502`) — applies equally to whatever tool replaces it; keep the `isContainer` guard logic for the drag-drop single-folder path.
- PII hardening of the import prompt (shipped earlier) — unchanged.
- The onboarding dock + MCP connection detection (Epic A A1–A10) — unchanged, though the step 2 "action log" pattern gets repurposed for the audit progress stream.
- The SSE event infrastructure — unchanged, extended to carry audit activity.
- The comparison script at `server/scripts/compare-discovery.ts` — keeps as dev tooling for now, though the functions it calls will be deleted. Either delete the script with them or point it at the new agent-led path.

## Implementation notes (for whoever picks this up)

The direction is locked. The exact sequencing is to be decided by what's easiest to land incrementally. Rough instinct:

1. Add `propose_spaces` tool + a minimal review modal that can render a plan. This is the new keystone; everything else hangs on it.
2. Rewrite `get_context`'s first-run playbook: *"don't use our discovery; audit the user's machine yourself with shell tools; call `propose_spaces(plan)` when ready."*
3. Wire the embedded OpenCode as the fallback invoker when no external agent is connected. Triggered by a dock button or drag-drop.
4. Repurpose the action-log stream for live audit progress.
5. Retire the old discovery tools + `discover_container` / `onboard_container` once the new path lands.
6. Adjust drag-drop to go through the same pipeline (OpenCode audits the single folder, proposes, user reviews).

Treat existing code as POC. Rewrite what doesn't fit. Unified experience > patches on patches.
