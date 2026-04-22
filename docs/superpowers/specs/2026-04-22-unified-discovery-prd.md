# Agent-led onboarding — PRD (minimal first cut)

**Date:** 2026-04-22
**Status:** Approved. Minimal shape; enhancements listed separately at the bottom.
**Related:** Epic A (#184), `docs/superpowers/specs/2026-04-21-onboarding-mcp-first-design.md`, supersedes the earlier 2026-04-22 version of this file.

## Why this exists

The MCP-first onboarding dock shipped on `feat/onboarding-mcp-first`. Testing revealed that an agent with its own shell, git, and conversational context produces a materially better set-up plan than Oyster's server-side LLM pipeline can. The agent found work outside `~/Dev`, classified third-party libraries correctly, proposed a `research` space we'd never have invented, and surfaced its own open questions for the user to push back on — all in the agent's own chat, using tools Oyster doesn't provide.

The conclusion: Oyster stops trying to classify the filesystem. The agent does that work. Oyster provides primitives and a surface for the output to land on.

## The flow

1. User says to an agent: *"Set up Oyster for me"* or *"Discover my projects"*. The agent is either an external MCP client (Claude Code, Cursor, Windsurf, Hermes, …) or Oyster's own chat bar, which routes to OpenCode. Both speak the same MCP surface.
2. The agent audits the filesystem with its own shell / read tools — `ls`, `cat`, `git log`, README reading. It probes common project locations (`~/Dev`, `~/Documents`, `~/Desktop`, `~/Projects`, cross-OS equivalents) and applies judgement about what's a real project vs noise vs something to flag for the user.
3. The agent presents the proposed plan in its own chat — spaces with reasons, items it'd filter as noise, open questions it wants the user to answer before applying.
4. The user reviews and confirms / adjusts in chat. *"You missed blunderfixer"* / *"Fold oyster-crm into oyster"* / *"Apply as-is"*.
5. The agent calls `onboard_space(name, paths[])` once per confirmed space. Oyster creates each space, attaches the paths, scans for artifacts. Spaces appear on the desktop.

One flow. One primitive. No Oyster-owned classifier.

## Principles

- **Agent is the brain.** Oyster provides primitives (`list_spaces`, `onboard_space`, `list_artifacts`, `get_context`). Discovery and grouping happen entirely in the agent's shell + context.
- **OpenCode is the universal fallback.** Users without an external agent still get the same flow — they ask Oyster's built-in chat bar, which routes to OpenCode, which does the audit with its own shell tools.
- **Chat-first review.** The plan lands in the agent's chat. The user confirms there. No Oyster-owned review modal in v1 — add one if UAT says chat-only feels cramped.
- **Ask, don't audit.** If the agent is unsure about a folder, it asks in chat — *"Is stockfish yours, a vendored dependency, or noise?"* No silent drops, no hidden recovery.
- **Recovery stays open.** After initial onboarding, the user can still create spaces via drag-drop (the Add Space form), ask the agent to add a folder, or re-run discovery any time.

## MCP surface

**Kept:**
- `list_spaces` — enumerate current spaces
- `list_artifacts(space_id)` — what's in a space
- `get_context` — the playbook that tells the agent how to do discovery; the onboarding dock's step 2 copy points the agent here
- `onboard_space(name, paths[])` — atomic primitive. Create a space and attach one or more folder paths. Scans each path. Multi-path lets the agent create `oyster` with all five `oyster-*` folders in one call.

**Retired:**
- `discover_container` — Oyster-owned discovery that the agent no longer needs.
- `onboard_container` — same reason.

## UI surface

- **Onboarding dock** (existing, kept). Step 2 still shows a copyable prompt pointing the user to ask their agent to set things up. The prompt text updates to emphasise *"audit thoroughly, present the plan to me first, then apply"*.
- **Add Space form** (existing `AddSpaceWizard`, kept — simplified). The simple "give me a name, drop a folder, create a space" form. Used for one-off single-folder adds post-onboarding. The old LLM-grouping discovery panel inside the same file is removed.
- **No new first-run UI.** The agent's own chat is the review surface in v1.

## Out of scope

- Changing artifact-detection rules (what counts as an app / deck / etc. inside a project).
- Non-discovery work (memories, sync, plugin registry).
- Full-screen live discovery view. The agent's own chat already streams its audit; duplicating that in an Oyster visualisation is an enhancement, not a requirement.
- GUI review modal on Oyster's desktop. Same — enhancement if chat-only review proves insufficient.

## Verification

A fresh install should pass every one of these:

- External Claude Code connected. User: *"Set up Oyster for me."* → agent audits the filesystem (takes minutes, progress visible in agent chat), presents plan in chat with spaces / reasons / open questions, user confirms, agent calls `onboard_space(...)` per space with multi-path arrays, spaces appear on Oyster's desktop.
- Same flow through Oyster's own chat bar (no external agent connected) — OpenCode handles it via its own shell tools. Same result.
- Drag a single folder onto the Oyster desktop → simple Add Space form opens pre-filled → user creates one space with that one folder. No LLM grouping step.
- MCP tool list no longer advertises `discover_container` / `onboard_container`. Docs and playbooks don't reference them.
- Reproduce yesterday's blunderfixer case via the agent flow — if the agent drops a real project, the user catches it in chat ("what about blunderfixer?") and the agent adds it in a follow-up `onboard_space` call. No silent loss.

## Enhancements — future work, not shipping now

Things the plan considered but we're deferring. Layer these on post-UAT only if observed pain calls for them:

- **Live discovery view.** Full-screen Oyster-owned visualisation of the agent's audit as it runs. May or may not add value over the agent's own chat.
- **`propose_spaces(plan)` + Oyster-owned review modal.** GUI review surface on the desktop instead of in the agent chat. Useful if plans get long and chat columns are cramped.
- **OpenCode-specific audit invocation.** A server-side wrapper that kicks off the audit prompt directly in OpenCode (bypassing the user typing it). Relevant only if we want the audit to auto-start on first run.
- **Drag-drop of a multi-project container.** Today's drag-drop goes to a simple Add Space form. If users want drop-a-dev-folder to trigger multi-space agent audit scoped to that folder, that's a future flow.
- **Richer post-onboarding add affordances.** Agent commands like *"add ~/NewProject"*, dock buttons for common adds, etc.
