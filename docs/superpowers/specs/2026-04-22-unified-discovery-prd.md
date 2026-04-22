# Unified discovery + onboarding — PRD

**Date:** 2026-04-22
**Status:** Approved. Implementation split into small chunks; chunks 3 and 5 require validation before committing to an approach.
**Related:** Epic A (#184), `docs/superpowers/specs/2026-04-21-onboarding-mcp-first-design.md`

## Why this exists

The MCP-first onboarding dock shipped end-to-end on `feat/onboarding-mcp-first`. Real-world testing surfaced two problems that exposed a deeper issue: drag-drop onboarding (GUI) and agent-led onboarding (MCP) are the same feature but have drifted into two separate code paths with different behaviour. They should be the same experience.

## Product requirement

Oyster helps the user do this, the same way every time:

1. **Find my projects.** Either here's a specific folder, or figure out where they are.
2. **Organize them into spaces.** Group related things. Set aside noise.
3. **Let me review and give feedback.** Confirm what looks right. Fix what doesn't (rename, move, skip, promote "not importing" items back in). Add anything that was missed — *"you missed blunderfixer"*.
4. **Import.** Apply the plan. Register artifacts, scan for apps, connect memories. Keep the door open for more later.

## Entry points

All four routes enter the same flow at step 1 and produce the same review screen at step 3. Agent-initiated flows open the GUI review modal on the user's desktop — not a chat-only narration.

- **Drop a folder on the desktop** — scope = that folder.
- **Click "Discover my projects" on the dock** — no scope; find candidates across common locations.
- **Agent: *"Set up Oyster for me"*** — no scope; agent triggers the same probe-and-propose flow.
- **Agent: *"Set up Oyster with my projects at ~/foo"*** — scope = that folder.

## Principles

- **One pipeline.** If drag-drop and agent-led do the same feature, they use the same code.
- **Everything visible.** No hidden buckets. The user sees what's being imported, what isn't, and can reclaim anything.
- **Ask, don't audit.** The defence against missed projects is a visible *"anything missing?"* prompt in review, not hidden recovery logic.
- **Recovery stays open.** After import, the user can still drag, click, or ask the agent to add more.

## Review screen shape

Three sections, same for every entry point:

1. **Spaces to create** — default enabled. Editable: rename / toggle / move folders.
2. **Not importing** — every item shown with its reason (e.g. *"cache directory"*, *"single-file config"*, *"third-party library"*). Default disabled. One click promotes an item into an existing space or a new one. This is where *"Blunderfixer should make the cut"* gets fixed if the LLM mis-classified it.
3. **Anything missing?** — a path input at the bottom. Adds a new group to the proposal before apply. Second defence against LLM + probe misses.

When the proposal comes from multiple source folders: header shows *"Found N spaces across M source folders"*.

## Out of scope

- Changing artifact-detection rules (what counts as an app / deck / etc. inside a project).
- Non-discovery work (memories, sync, plugin registry, etc.).
- Broadening to non-code artifact types — separate workstream.

## Verification (end-to-end)

After implementation, a fresh install should pass every one of these:

- Drag `~/Dev` on the desktop → review screen with the three sections → apply → desktop populates with grouped spaces.
- Click "Discover my projects" on the dock → same review screen with combined sources.
- Say to Claude Code *"Set up Oyster for me"* → same review screen opens on the desktop (not chat).
- Say to Claude Code *"Set up Oyster with my projects at ~/foo"* → same review screen scoped to `~/foo`.
- Reproduce the blunderfixer silent-drop case: when the LLM omits a real project, the user can promote it from "Not importing", or add it via "Anything missing?" — it lands in apply.
- `onboard_container(~/Dev/oyster-os)` (single project path) → exactly one `oyster-os` space, not N junk spaces from its subdirs.

## Implementation notes

Implementation is chunked and lives in the planning doc, not here. A few load-bearing decisions, flagged for validation before committing:

- **One discovery + grouping pipeline.** Today two parallel paths exist. They must converge. Which path wins (marker-first or full-classification) is an engineering decision to validate against real containers.
- **Review UI shape.** The three-section layout should be mocked statically and walked with a user before becoming React components.
- **Agent handoff to the GUI modal.** The proposal is a new MCP call that opens the wizard with a pre-filled plan. UAT whether this feels intrusive; be willing to revisit.
- **Existing code is POC.** No component is sacred. Rewrite where it helps.
