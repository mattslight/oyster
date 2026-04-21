# MCP-First Onboarding — Design Spec

**Date:** 2026-04-21
**Driver:** Bharat + Merlin first-run feedback; Reddit launch readiness
**Scope:** Reframe onboarding around "connect your AI and drive Oyster from there" instead of "use this chat UI"

---

## Problem

First-run today lands users on the desktop with an `OnboardingBanner` offering "Import from AI" or a disabled "Scan my machine". The implicit pitch is *"Oyster is a workspace, chat with it"*. That framing is a bad fit for Oyster's actual distinguishing feature and for the Reddit dev audience:

- **Oyster is an MCP server.** Its unique pitch is "any MCP-capable AI can drive this workspace" — not "here's another chat UI".
- **Devs already have a preferred AI.** Claude Code, Cursor, Windsurf users don't want to leave their tool. They want Oyster to *extend* what they're already doing.
- **The `connect-your-ai` builtin is buried.** It's a surface artifact among others. Should be the front door.
- **Drag-and-drop is nice-to-have, not the headline.** The naive UI framing competes with the MCP story.

Feedback evidence:
- Bharat (Ubuntu, Hermes user): wanted AI-led install — "use the LLM to install oyster"
- Merlin (Windows, OpenAI): MCP scope friction (#175 — now fixed), userland location confusion (#182), but once connected it worked first try

## Goal

Reframe first-run onboarding as three explicit, MCP-driven steps:

1. **Connect your AI via MCP** — one command for Claude Code / Cursor / VS Code / Windsurf
2. **Onboard your projects, set up your spaces** — tell your AI: "onboard `~/Dev/my-project` and `~/Dev/other-project`" → Oyster's MCP tools create spaces and scan artifacts
3. **Import memories from cloud AI** — copy-paste flow (builds on #107 import) to bring context from Claude.ai / ChatGPT

Make the existing desktop UI (drag/drop, chat bar) clearly secondary — still present, but framed as "you can also do this directly if you want".

## Non-goals

- Not rewriting the chat bar or desktop
- Not implementing auto-install / agent-led install (#178) — that's a follow-up
- Not building a session registry (#176) — future design fork
- Not blocking on userland tidy (#172 / #182) — parallel track

## Proposal

### 1. Replace `OnboardingBanner` with a 3-step guided flow

Render on the home space until dismissed or all 3 steps completed. One step active at a time, completed steps collapse, user can revisit any.

**Step 1 — Connect your AI**
- Shows the same tab UI as `connect-your-ai` builtin (Claude Code / Cursor / VS Code / Windsurf)
- Uses dynamic `mcpUrl` from `window.location.origin + '/mcp/'`
- Copy button for the install command
- Completion detection: poll `/api/mcp/sessions` (or equivalent) → step marks complete once *any* external MCP client has connected

**Step 2 — Onboard your projects**
- Prompt the user: *"Go to your AI and say: 'onboard my projects at `~/Dev/my-project` and `~/Dev/other-project`'"*
- Show copyable example prompt with `$HOME/Dev` placeholder
- Completion detection: poll space count — step completes when ≥1 non-home space exists with `repo_path` set
- Also shows a fallback: "Or use the Oyster chat bar: `onboard ~/Dev/my-project`"

**Step 3 — Import memories (optional)**
- Links to the existing `import-from-ai` builtin / #107 flow
- Copy-paste prompt → paste JSON → preview → apply
- Marked optional — can skip

### 2. Demote `OnboardingBanner`

Delete the existing `OnboardingBanner.tsx`. Replace its mount point with the new `OnboardingChecklist` component. Same dismissal pattern (persists in localStorage).

### 3. Desktop/chat bar unchanged

The existing UI keeps working. Once onboarding is dismissed or complete, the experience is identical to today. No refactor of `Desktop.tsx` or `ChatBar.tsx`.

### 4. Copy changes in `connect-your-ai` builtin

Keep the builtin (users will revisit it), but update copy to match the new "front door" framing — already close, just needs minor word changes to line up with the onboarding checklist phrasing.

## Components to Create

- `web/src/components/OnboardingChecklist.tsx` — 3-step flow, step state in localStorage + polled completion signals
- `web/src/components/OnboardingStep.tsx` — shared step UI (number, title, body, status badge, collapse/expand)

## Components to Modify

- `web/src/App.tsx` — swap `OnboardingBanner` → `OnboardingChecklist`
- `web/src/components/OnboardingBanner.tsx` — delete
- `server/src/index.ts` — add `/api/mcp/status` endpoint returning `{ connected_clients: number, last_client_connected_at: string | null }` (derivable from MCP session tracking that already exists)
- `builtins/connect-your-ai/src/index.html` — minor copy alignment

## API Additions

**`GET /api/mcp/status`**

```json
{
  "connected_clients": 1,
  "last_client_connected_at": "2026-04-21T14:22:11Z"
}
```

Used by step 1 to detect "user has connected an external MCP client". Not strictly required if detection proves tricky — fallback is a user-clicked "I've connected it" button.

## Copy (verbatim for Bharat/Merlin re-test)

> **Oyster is an MCP server. Drive it from the AI you already use.**
>
> **1. Connect your AI**
> Pick your client and run the command:
> [tabs: Claude Code / Cursor / VS Code / Windsurf]
> `claude mcp add --scope user --transport http oyster http://localhost:4444/mcp/`
>
> **2. Onboard your projects → set up your spaces**
> Now talk to your AI. Try:
> *"Onboard my projects at ~/Dev/oyster and ~/Dev/blunderfixer"*
> Oyster's MCP tools will scan each folder, create spaces, and fill them with artifacts.
>
> **3. Import your memories** *(optional)*
> Bring context from Claude.ai or ChatGPT. Oyster generates a prompt, you paste it into your AI, then paste the result back here.
> [Open the import flow →]

## Testing Plan

After implementation:
1. Self-test on clean `~/.oyster` (move existing aside)
2. Bharat re-test (Ubuntu + Hermes) — focus on step 1 completion detection and step 2 prompt phrasing
3. Merlin re-test (Windows + OpenAI via Claude Code) — focus on the `--scope user` framing and multi-project onboarding flow
4. Ship as `0.3.9-beta.0` → iterate on feedback → promote to `0.3.9` → Reddit post

## Risks / Open Questions

- **Completion detection for step 1:** If the MCP session tracking isn't granular enough to distinguish "external client" from "internal OpenCode subprocess", fall back to a manual "I've connected it" confirmation button.
- **Step 2 completion signal:** Polling space count is cheap but means a user who creates a space manually (not via MCP) also marks step 2 complete. Acceptable — user has set up a space either way.
- **localStorage dismissal:** If users want to resurface onboarding, need a "show onboarding again" entry somewhere. Low priority — most users dismiss once.

## Out of Scope

- Animated/interactive "your AI is doing things" telemetry (future)
- Agent-led install that writes MCP config on the user's behalf (#178)
- Session registry UI (#176)

---

## Follow-up tickets after ship

- #181 — "no AI connected" state still valid; onboarding checklist surfaces when no MCP is connected, but runtime errors (bad `auth.json`, removed env key) still need the 502-to-banner fix
- #178 — once the manual flow is proven, consider auto-writing MCP config via a small installer

## Estimate

~1-2 days of focused work:

- `OnboardingChecklist.tsx` + `OnboardingStep.tsx`: half day
- `/api/mcp/status` endpoint: hour
- Copy changes + builtin alignment: hour
- Polish + clean-install testing: half day
- Beta ship + Bharat/Merlin re-test loop: 1-2 days

Total including feedback cycle: ~3-4 days before Reddit post.
