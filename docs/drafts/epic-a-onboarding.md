# Epic A — MCP-first onboarding

## Goal

Reframe first-run so a stranger lands at `localhost:4444` and immediately understands *"Oyster is an MCP server — drive it from the AI you already use"*. Replace the current "Import from AI" banner with a 3-step checklist that makes the MCP story the front door.

## Why now

Feedback from the 0.3.7 / 0.3.8-beta install wave:

- **Bharat** (Ubuntu, Hermes): expected AI-led install, hit the hardcoded-model bug (#174), raised the MCP scope bug (#175), paused on pasting cloud AI export because of PII (kid's name, API keys)
- **Merlin** (Windows, OpenAI via Claude Code): first install worked once #175 shipped; confused about userland location (#182)
- Neither saw "Oyster is an MCP server" as the headline. The UI implies "chat with this workspace".

Reddit launch audience = strangers without the friend-bridge Bharat had. A thin first impression kills the thread.

## Spec

`docs/superpowers/specs/2026-04-21-onboarding-mcp-first-design.md`

## Terminology discipline

Three concepts currently blur in user copy. UI wording MUST be ruthless:

| Concept | What it is | User-facing language |
|---|---|---|
| **AI provider** | The LLM brain Oyster uses internally (Anthropic, OpenAI via OpenCode). Handled at CLI first-run. | Don't surface unless broken. If shown, say *"your AI brain"*, not *"your AI"*. |
| **Your agent** | External tool (Claude Code, Cursor, Windsurf, Hermes) that drives Oyster via MCP. | Always *"your agent"* or name the specific tool. Never *"your AI"* in step 1. |
| **MCP** | The protocol connecting the agent to Oyster. | Keep it — audience is dev-heavy, MCP is known. But it's plumbing; lead with what the user gets, not the protocol. |

Step titles reflect this: *"Connect your agent"*, not *"Connect your AI"*.

## Story list

| # | Story | Effort |
|---|---|---|
| A1 | Onboarding shell: `OnboardingChecklist` container + `OnboardingStep` row. Collapsible, active-step gating, persistent dismiss, localStorage step state. Swaps in where `OnboardingBanner` mounts. | 4h |
| A2 | Step 1 body — Connect your agent via MCP. Tabbed client selector (Claude Code / Cursor / VS Code / Windsurf). Live MCP URL, copy button, manual "I've connected it" confirm. Extract tab UI from `connect-your-ai` builtin. | 1h |
| A3 | Step 2 body — Drop `~/Dev` → scan → spaces. **Primary path: folder drop** (works without an agent configured; fastest feedback loop; builds on #108). **Secondary path: agent-prompt** — small link under the drop zone: *"Or ask your agent: `onboard my projects at ~/Dev`"*. Never show both at equal weight. Completes on scan result. | 1–2h |
| A4 | Step 3 body — Import your memories (optional). Trust-first copy: *"Everything stays on your machine."* Clear opt-in, skip button. CTA opens existing #107 import flow. | 30m |
| A5 | PII-harden the #107 export prompt. Add instruction to the cloud AI: *"exclude API keys, credentials, passwords, and personal details about third parties (children, family, colleagues)"*. Single string change. | 15m |
| A6 | Delete `OnboardingBanner.tsx`, unreference from `App.tsx`, drop CSS. | 15m |
| A7 | Step 1 auto-detect (optional polish). SSE push from server on MCP client connect (prefer) or `/api/mcp/status` poll. Must filter out the internal OpenCode subprocess. | 1–2h |
| A8 | `connect-your-ai` builtin copy alignment with checklist. Minor word changes so the two surfaces don't contradict. | 30m |

## Dependencies / consumes

- Builds on #108 (local HDD scan) for story A3
- Builds on #107 (cloud AI import) for stories A4, A5
- Does not block on #172 / #182 — runs in parallel with Epic B

## Out of scope

- Secret scanner on paste (dropped this iteration)
- Per-item `[remove]` affordance on import preview (dropped this iteration)
- #181 (runtime "no AI connected" 502 loop) — separate track
- #178 (agent-led install that writes MCP config) — follow-up after flow proves
- Session registry UI (#176)

## Launch gate

Ship as `0.3.9-beta.0`. Bharat re-tests on Ubuntu + Hermes. Merlin re-tests on Windows + Claude Code + OpenAI. If both complete all three steps without friction, promote to `0.3.9` and post on Reddit.

## Estimate

- Must-have stories (A1–A6): ~6.5h
- Plus polish (A7–A8): ~9.5h
- End-to-end including beta + re-test + fixes + ship: 3–4 days
