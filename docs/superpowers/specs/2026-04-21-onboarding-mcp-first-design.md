# MCP-First Onboarding — Design Spec

**Date:** 2026-04-21 (revised 2026-04-21 to adopt dock + agent-led pattern)
**Driver:** Bharat + Merlin first-run feedback; Reddit launch readiness
**Scope:** Replace the existing `OnboardingBanner` with a quiet **dock pill** in the topbar that hands setup to the user's connected agent and lets Oyster's surface populate live as the agent works.

---

## Problem

First-run today lands users on the desktop with an `OnboardingBanner` offering "Import from AI" or a disabled "Scan my machine". The implicit pitch is *"Oyster is a workspace, chat with it"*. That framing is a bad fit for Oyster's actual distinguishing feature and for the Reddit dev audience:

- **Oyster's unique pitch is "your agent drives it".** The banner doesn't demonstrate that — it looks like a generic chat UI.
- **Devs already have a preferred agent.** Claude Code, Cursor, Hermes users want Oyster to *extend* what they're already doing, not replace their chat surface.
- **Technical jargon loses non-devs.** "Oyster is an MCP server" confuses rather than sells. (Merlin's response tested this.)
- **Naïve checklist UI competes with the desktop.** A big card on the home surface fights the user's content instead of making space for it.

Feedback evidence:
- Bharat (Ubuntu, Hermes user): wanted AI-led install — *"use the LLM to install oyster"*. Paused on pasting cloud AI export because of PII (kid's name, API keys).
- Merlin (Windows, Claude Code + OpenAI): MCP scope friction (#175 — now fixed), userland location confusion (#182), but once connected it worked first try.

## Goal

Reframe first-run so the **only explicit user action is connecting their agent**. Everything else is the agent proving it can drive Oyster — the surface populates in real time as MCP tools fire, and Oyster's own UI stays out of the way.

Three conceptual steps:

1. **Connect Oyster to your agent** — one command per client (Claude Code / Cursor / VS Code / Windsurf). The only step the user completes manually.
2. **Ask your agent to set things up** — user pastes a prompt into their connected agent; the agent calls Oyster's MCP tools; Oyster's desktop populates live.
3. **Import your memories** *(optional)* — back in Oyster because the memory store is local and the trust decision belongs to the user (not the agent).

## Non-goals

- Not rewriting the chat bar or desktop
- Not implementing auto-install / agent-led install (#178) — follow-up
- Not building a session registry (#176) — future design fork
- Not blocking on userland tidy (#172 / #182) — parallel track (Epic B, #185)
- No folder-drop / local scan path in this pattern — the agent-driven flow *is* the path. Folder-drop belongs to a different UX era of Oyster and would dilute the pitch.

## Proposal

### 1. Dock pill in the topbar

A small persistent pill lives in the Oyster topbar. It has three states:

- **Fresh install / setup incomplete:** `Set up Oyster · N/3` with a soft pulsing dot. Subtle, discoverable.
- **Working:** `Set up Oyster · N/3 (agent working)` with the pulse. Appears during step 2 while MCP calls are streaming in.
- **Done:** collapses to `✓ Set up` — a tiny pill that persists indefinitely. Click to re-expand for docs or re-run any step.

Clicking the dock opens a **popover anchored below it**, showing **one step at a time**. Never a sidebar, never a modal, never a card on the home space.

### 2. Popover content per step

**Step 1 — Connect Oyster to your agent**
- Client tabs: Claude Code / Cursor / VS Code / Windsurf
- Live MCP URL from `window.location.origin + '/mcp/'`
- Copyable command
- Live status: *"Waiting for your agent to connect…"* (pulses until detected)
- On detection: popover auto-advances to step 2; dock flips to `1/3 ✓`

**Step 2 — Ask your agent to set things up**
- Single copyable prompt: *"Set up Oyster with my projects at ~/Dev. Use the oyster MCP tools."*
- Live action log showing recent MCP tool calls: `✓ onboard_space oyster`, `✓ scan_space oyster (14 artifacts)`, etc.
- As tools fire, Oyster's desktop populates live via SSE — spaces appear in the space row, artifact tiles animate into the desktop grid.
- Completion heuristic: dock marks step 2 done after the agent calls `onboard_space` *and* at least one other tool (scan, create_artifact, etc.).
- Manual "I'm done with this step" fallback if the agent never fires MCP calls.

**Step 3 — Import your memories** *(optional)*
- Trust-first copy: *"Everything stays on your machine. Oyster never sends your paste anywhere."*
- Clear opt-out (skip button).
- CTA opens the existing #107 import flow.

### 3. Desktop and chat bar unchanged

The existing UI keeps working. No refactor of `Desktop.tsx` or `ChatBar.tsx`. The dock lives in whatever wraps those (topbar chrome).

### 4. `connect-your-ai` builtin stays as reference material

The builtin artifact tile stays on the home surface — for users revisiting setup or re-running a step after dismissal. Minor copy alignment so it doesn't contradict the dock's wording.

## Components to Create

- `web/src/components/OnboardingDock.tsx` — the pill + popover anchoring
- `web/src/components/OnboardingDock/Step1Connect.tsx` — client tabs, copy command, wait state
- `web/src/components/OnboardingDock/Step2AgentWork.tsx` — copyable prompt, live MCP action log
- `web/src/components/OnboardingDock/Step3Memories.tsx` — trust-first CTA linking to #107

## Components to Modify / Delete

- `web/src/App.tsx` — mount `OnboardingDock` in topbar, remove `OnboardingBanner` mount
- `web/src/components/OnboardingBanner.tsx` — **delete**
- `server/src/index.ts` — extend SSE channel with `mcp_client_connected` and `mcp_tool_called` events
- `server/src/mcp-server.ts` — emit events on client session open and on every tool call
- `builtins/connect-your-ai/src/index.html` — minor copy alignment

## SSE Events

Extend the existing SSE push stream (already used for artifact updates) with:

```jsonc
// When a non-internal MCP client connects
{ "type": "mcp_client_connected", "client": "claude-code", "at": "2026-04-21T14:22:11Z" }

// When any MCP tool is invoked
{ "type": "mcp_tool_called", "tool": "onboard_space", "args_summary": "oyster", "at": "..." }
```

**Critical:** filter out the internal OpenCode subprocess — otherwise step 1 auto-completes on server boot. Detect by session origin / a flag set when spawning the subprocess.

## API (optional fallback)

`GET /api/mcp/status` returning `{ connected_clients: number, last_client_connected_at: string | null }` — useful if SSE push isn't reliable across the connect point. Also supports the manual "I've connected it" button as a fallback.

## Copy (verbatim for Bharat/Merlin re-test)

> **Dock (collapsed, fresh install):** `Set up Oyster · 0/3`
>
> **Step 1 popover:**
> *Connect Oyster to your agent*
> Pick the agent you use. Run the command once — your agent will drive the rest of the setup for you.
> [tabs: Claude Code / Cursor / VS Code / Windsurf]
> `claude mcp add --scope user --transport http oyster http://localhost:4444/mcp/`
> *Waiting for your agent to connect…*
>
> **Step 2 popover:**
> *Ask your agent to set things up*
> Paste this into Claude Code. Your agent will create spaces for your projects and scan them into Oyster using MCP tools.
> `Set up Oyster with my projects at ~/Dev. Use the oyster MCP tools.`
> *Watching for your agent's activity…* → live action log
>
> **Step 3 popover:**
> *Bring in your memories*
> Copy context from Claude.ai or ChatGPT. Oyster generates a prompt you paste there, then paste the result back here.
> **Everything stays on your machine.** Oyster never sends your paste anywhere.
> [Open import →] [Skip]
>
> **Dock (done):** `✓ Set up`

## Testing Plan

1. Self-test on clean `~/.oyster` (move existing aside)
2. Bharat re-test (Ubuntu + Hermes) — focus on step 1 auto-detection (Hermes is a non-Claude-Code MCP client) and whether the live action log actually populates
3. Merlin re-test (Windows + Claude Code + OpenAI) — focus on whether step 2's prompt ergonomic copy clearly communicates "paste this into Claude Code"
4. Ship as `0.3.9-beta.0` → iterate on feedback → promote to `0.3.9` → Reddit post

## Risks / Open Questions

- **MCP client detection:** filtering the internal OpenCode subprocess is load-bearing. If we can't reliably distinguish external vs internal sessions, step 1 never progresses or progresses on boot. Mitigation: set a flag on the subprocess at spawn time, filter by that flag in the session tracker.
- **Step 2 completion signal:** "agent called onboard_space AND something else" is a heuristic. Could miss cases. Mitigation: manual "done" button in the popover as a fallback.
- **Action log volume:** high-volume agents (e.g. scanning many repos) could spam the log. Show last N entries with scroll, oldest auto-trimmed.
- **Dock discoverability:** quieter than a banner. Mitigation: soft pulse on the dock until step 1 starts. If users miss it, they fall back to the persistent `connect-your-ai` builtin tile for guided setup.
- **Dismissal + resurface:** dismissing setup collapses the dock to a minimised pill that stays forever. Click to re-expand. No hidden menu to find.

## Out of Scope

- Agent-led install that writes MCP config on the user's behalf (#178) — follow-up after flow proves
- Session registry UI (#176)
- Auto-drop-folder onboarding — removed in this revision, belongs to a different UX era
- Per-item review/remove on memory import — dropped this iteration (earlier story #7/#8)

## Follow-up tickets after ship

- #181 — "no AI connected" 502 loop. Dock surfaces the connect path but runtime chat errors (broken `auth.json`) still need a structured-4xx → banner fix.
- #178 — once the manual flow is proven, consider an installer command that writes MCP config for the user.

## Estimate

~2-3 days of focused work. Higher than the original accordion spec because SSE event emission is now load-bearing (not polish):

- `OnboardingDock` + three step components: ~5h
- SSE `mcp_client_connected` + `mcp_tool_called` emission: ~3h
- MCP session tracker: filter internal OpenCode subprocess: ~2h
- Live action log component: ~2h
- `/api/mcp/status` fallback endpoint: ~1h
- Delete `OnboardingBanner`, mount `OnboardingDock`: ~30m
- PII hardening of #107 export prompt: ~15m
- Copy alignment on `connect-your-ai` builtin: ~30m
- Polish + clean-install testing: half day

Total including beta + Bharat/Merlin re-test loop: ~3–5 days before Reddit post.
