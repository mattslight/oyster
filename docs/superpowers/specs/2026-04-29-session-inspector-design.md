# Session Inspector Slide-Panel — Design

**Issue:** [#253](https://github.com/mattslight/oyster/issues/253)
**Milestone:** 0.5.0 Sessions arc — Sprint 4 of 8
**Visual reference:** `docs/mockups/brain-prototype.html` (`renderSessionPanel`, `renderArtefactPanel`)

## Problem

Sessions appear as tiles on Home but clicking them does nothing. Users can see "active · waiting · disconnected · done" pips but can't read the transcript, see which artefacts a session touched, or get a resume command for a disconnected agent. Same for artefacts: tiles open but there's no way to ask "which sessions touched this thing".

## Solution

A right-anchored slide-panel inspector, used for both sessions and artefacts, that opens on tile click and provides:

- **Session inspector:** state-conditional banner (disconnected/waiting), tabs for Transcript and Artefacts, footer with copy-resume-command and copy-session-id actions
- **Artefact inspector:** lightweight metadata header (icon, title, kind, path/source) + linked Sessions list + Open/copy-id footer. **No content preview** — full rendering remains the existing artefact viewer's job.

Live updates over SSE so an open inspector reflects the current state of an active session as new turns stream in.

## Scope cut from this PR

Three follow-up tickets filed to keep this PR focused:

- **[#270](https://github.com/mattslight/oyster/issues/270)** — Summary tab + resume-in-TUI token math (needs summariser service)
- **[#271](https://github.com/mattslight/oyster/issues/271)** — Files tab (needs watcher to extract Edit/Write tool-call paths)
- **[#272](https://github.com/mattslight/oyster/issues/272)** — Memory tab (needs session_id plumbed through `remember`/`recall`)

Also deferred:

- **URL routing** — open-panel state is client-only (`activePanel` in Home). URL sync (`?session=<id>`) is a follow-up.
- **Mark closed action** — watcher's heartbeat detects state transitions; manual override is marginal.
- **Tool-call rich rendering** — transcript renders `session_events.text` with role styling; tool calls show a one-line summary with click-to-expand `raw` JSON (capped at 4KB).
- **Branch in TUI / Export transcript** — footer simplifies to copy-command + copy-id for v1.

## Architecture

### Single-shell panel

One generic `<InspectorPanel>` (chrome only) renders the slide container, backdrop, escape-key handler, and portal-to-body. Content is delegated to `<SessionInspector>` or `<ArtefactInspector>` based on `activePanel.kind`.

The prototype already validated that header + state-banner + tabs + body + footer is the right chrome for both kinds — splitting into two panels would duplicate that chrome. The cost of one shared shell is one prop discriminator; the cost of two is duplicated CSS, duplicated open/close logic, and divergent close behaviour.

### Open/close behaviour

Three close paths converge on one handler (parity with `ConfirmModal`):

1. Escape key (window-level listener, mounted while open)
2. Backdrop click (`onMouseDown` checking `e.target === e.currentTarget`)
3. `✕` button in panel header

Portal target: `document.body` so the panel escapes any parent stacking context (Desktop's chat-bar container creates one — same reason `ConfirmModal` portals).

### Live updates (sessions only)

`<SessionInspector>` subscribes to the existing `session_changed` SSE event already broadcast by `server/src/watchers/claude-code.ts`. When `event.id === activePanel.id`, it refetches:

- `/api/sessions/:id` (header refresh — state pip, last activity)
- `/api/sessions/:id/events` (append-only; cheap)

**Race protection** (the watcher can fire many `session_changed` events in a burst when the agent writes several JSONL lines):

- **AbortController per session ID** — when `activePanel.id` changes, abort the in-flight fetch for the previous session before starting the new one
- **Stale-response guard** — each fetch captures the current `id` in closure; on resolve, ignore the response if `id !== activePanel.id`
- **Debounce** — coalesce `session_changed` bursts with a trailing-edge 200ms debounce so a burst of 5 JSONL lines fires one refetch, not five
- **Single subscription** — Home owns the EventSource (already does, for the grid). The inspector subscribes via a callback prop or context — no second EventSource per inspector mount

Artefacts don't transition, so `<ArtefactInspector>` is snapshot-at-open with no SSE wiring.

### Cross-navigation

A row in the Session inspector's Artefacts tab calls `setActivePanel({ kind: 'artefact', id })`, swapping panel content without close-then-reopen. Same in reverse for Sessions tab on an artefact. The shell remains mounted; the inner inspector remounts with new state.

## Components

### New files

| File | Purpose |
|---|---|
| `web/src/components/InspectorPanel.tsx` | Chrome shell (backdrop, slide container, escape handler, portal); receives `activePanel` and renders the right inspector inside |
| `web/src/components/InspectorPanel.css` | Panel styles — adapted from prototype `.panel*` rules (lines 951–1320) |
| `web/src/components/SessionInspector.tsx` | Header + state banner + tabs (Transcript, Artefacts) + footer |
| `web/src/components/ArtefactInspector.tsx` | Metadata header (icon, title, kind, path/source) + linked Sessions list + footer |

### Modified files

| File | Change |
|---|---|
| `web/src/components/Home.tsx` | `onClick` on `SessionTile` / `SessionRow` / artefact tiles; `activePanel` state; render `<InspectorPanel>` |
| `web/src/data/sessions-api.ts` | Add `fetchSession(id)`, `fetchSessionEvents(id)`, `fetchSessionArtifacts(id)` |
| `web/src/data/artifacts-api.ts` | Add `fetchSessionsForArtifact(id)` |
| `server/src/index.ts` | Four new GET routes (see Data flow below) |

### Reused (no changes)

- `ArtifactIcon` for per-row thumbs in cross-link lists (Artefacts tab on session, Sessions tab on artefact)
- `formatRelative` from Home.tsx for timestamps. **Inline-import** for now (don't extract to a `lib/` module in this PR — keep change surface minimal)
- `session-store.ts` already exposes `getEventsBySession` / `getArtifactsBySession` / `getSessionsByArtifact`

## Data flow

### New API endpoints (server/src/index.ts)

| Method | Path | Returns |
|---|---|---|
| GET | `/api/sessions/:id` | `Session` (single row) or 404 |
| GET | `/api/sessions/:id/events` | `SessionEventRow[]` (oldest first; full transcript — pagination is a future concern, not in this PR) |
| GET | `/api/sessions/:id/artifacts` | `Array<SessionArtifact & Artifact>` (joined; consumer wants both the role/timestamp and the artifact metadata) |
| GET | `/api/artifacts/:id/sessions` | `Array<SessionArtifact & Session>` (joined; reverse direction) |

All four endpoints are thin wrappers over existing store methods. No new SQL.

### Open-session sequence

1. User clicks `SessionTile` → `setActivePanel({ kind: 'session', id })`
2. `<InspectorPanel>` mounts → portal renders backdrop + slide container
3. `<SessionInspector>` mounts inside; `useEffect` fires three parallel fetches: session row, events, artefacts
4. While mounted, SSE `session_changed` listener: if `event.id === id`, refetch session + events

### Open-artefact sequence

1. User clicks artefact tile (or row inside session's Artefacts tab) → `setActivePanel({ kind: 'artefact', id })`
2. Same chrome; `<ArtefactInspector>` mounts → fetches artifact metadata + reverse session list
3. No SSE — artefacts don't transition

### Artefact panel content (v1)

The artefact inspector is deliberately shallow in #253. The inspector should prove the navigation model and session provenance first; rich artefact rendering remains the responsibility of the existing artefact viewer.

Layout:

- **Header** — icon (large `ArtifactIcon`), title, sub-line "kind · path-or-source · last modified"
- **Body** — single section: "Sessions that touched this" (the linked sessions list with role chips). No tabs — there's only one section.
- **Footer** — "Open" (delegates to existing artefact open behaviour), "Copy artefact ID"

No content preview, no iframe, no notes-content fetch. That means the design needs zero new artefact endpoints: the existing artefact metadata route already serves what the header needs.

## Error handling

| Scenario | Behaviour |
|---|---|
| Fetch fails (network, 500) | Inline error inside panel body: "Couldn't load session: <message>". No retry button — close and reopen retries. |
| Session/artefact 404 | Close panel; toast "Session no longer available" / "Artefact no longer available" |
| Empty transcript (active session, watcher pre-ingest) | "No transcript yet. Live updates active." with a small pulse indicator |
| Empty artefacts list | "No artefacts touched yet." |
| Empty sessions list (artefact tab) | "No sessions have touched this artefact." |
| Tool-call event with empty `text` | Render a one-line summary ("Tool call: `<tool_name>`") + click-to-expand showing the `raw` JSON. Cap expanded JSON at 4KB; if over, show first 4KB with `…truncated, N more bytes` footer. |
| Clipboard API unavailable (HTTP, no permission) | Toast falls back to "Copy failed — resume command: `claude-code --resume <id>`" with the command shown inline |

## Testing

Per project convention (CLAUDE.md: test UI in a browser before reporting done), unit-light + manual:

**Type-check + build:**
- `cd web && npm run build`
- `cd server && npm run build`

**Browser verification (golden + edge):**
- Open a `done` session — full transcript renders
- Open an `active` session; kick a turn from a real `claude` instance in a registered space — new turn streams in within ~1s
- Open a `disconnected` session — banner shows last-heartbeat; "Copy resume command" copies `claude-code --resume <session-id>`; toast confirms
- Open a session with touched artefacts — Artefacts tab shows them with role chips
- Click a row in Artefacts tab — panel swaps to artefact inspector with same artefact selected
- Click a row in the artefact's Sessions list — panel swaps back to session inspector
- Press Escape, click backdrop, click `✕` — all three close the panel
- Open inspector on Tokinvest space tile (scoped) — only Tokinvest sessions are clickable in the Sessions section behind the panel

## Out-of-scope future work

Captured here so reviewers know what's deliberately not in this PR:

- Pagination/virtualisation for very long transcripts (>500 events) — current sessions are small enough not to matter
- Search/filter within transcript — Cmd+F still works on the rendered DOM
- URL routing for inspector state (`?session=<id>` for shareable deep links)
- Manual "Mark closed" action on disconnected banner
- Branch session / Export transcript footer actions
- Rich tool-call rendering (parsed `tool_use` args, structured `tool_result` blocks beyond raw JSON expand)
- Artefact content preview inside the inspector (notes excerpts, deck pages, table grids) — full content rendering stays with the existing artefact viewer
