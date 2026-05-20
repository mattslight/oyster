# Terminal minimise UX — design

**Status:** Draft for review · 2026-05-19 · branch `terminal-minimise-ux`

## Goal

When the user clicks × on an embedded Claude Code terminal panel, *minimise* the panel — keep the PTY alive on the server, and surface a clearly discoverable affordance to restore it. Today × silently removes the panel from `windows` state while the PTY keeps running with no way to re-find it.

The user's mental model: *"Like macOS dock / Windows taskbar — I can see what's running, click to come back, and there's a separate explicit kill action when I actually want to end the session."*

## Current state

**Close handler** (`web/src/components/TerminalWindow.tsx:13,169`, `web/src/App.tsx:602`): × calls `onClose` → `dispatch({ type: "CLOSE", id })` → `windows.ts:114` removes the window from state. The WebSocket closes. The PTY keeps running on the server.

**Server PTY lifecycle** (`server/src/claude-pty-manager.ts:98-283`): `ClaudePtyEntry` tracks `exitedAt` (null = running), `clients: Set<WebSocket>` (attached browser connections), `evictTimer` (auto-delete 30s after exit). `linkedSessionId` exists in memory after auto-link but is not persisted to the `sessions` table. `DELETE /api/terminals/:id` (`routes/terminals.ts:307`) calls `kill()` → `proc.kill()` + schedule eviction.

**Sessions list** (`web/src/components/Home/index.tsx:107-135`) renders pills `live · waiting · done · all` derived from `SessionState = "active" | "waiting" | "disconnected" | "done"` (`shared/types.ts:82`). State changes via JSONL ingest. **No concept of "a live terminal is attached"** — the list has no idea PTYs exist.

**No dock / tray / persistent indicator.** Closing the panel is the last visible touchpoint with that PTY until the user happens to wander into the Sessions list.

**Roadmap note** (`docs/plans/roadmap.md:140`): a future "peek-and-attach view" is mentioned for issue #470 (post-1.0.0). This spec lays the data-model groundwork for it.

## Design

### Two new live states (internal name → UI label)

| Internal | UI label | Meaning | Visual | Chip |
|---|---|---|---|---|
| `attached` | **Open** | PTY alive, a window is open in front of the user | filled teal dot `#5eead4`, left accent stripe | none — being looked at is its own affordance |
| `running` | **Minimised** | PTY alive, no window open | outlined purple dot `#a78bfa`, left accent stripe | **Restore** |

Code uses `attached / running` because they map to PTY-manager vocabulary (`clients.size > 0` = attached, PTY process running = running). All user-facing copy uses **Open / Minimised** because they match the mental model of a window. The umbrella term shown in the topbar is **Live** (= open + minimised).

These compose with the existing `SessionState`. A session is e.g. *waiting AND open* if Claude is awaiting input and the panel is visible. Visually we lead with the live-state (teal/purple) when present and fall back to the existing yellow/grey dot when absent.

### Three surfaces

**1. Topbar pill** *(new)* — `web/src/components/Topbar/RunningTerminalsPill.tsx`

```
⏵ Running 2 ▾
```

- Single teal pulse + count. Hidden entirely when `count === 0`.
- Click opens a popover anchored to the pill.
- Popover lists one row per live PTY:
  - filled teal dot (Open) or outlined purple dot (Minimised)
  - title (session title, ellipsised)
  - meta line: `<space> · claude-code · <activity>` where `<activity>` is `cooking <Ns>` / `waiting for input` / `idle <duration>` / `minimised <Ns>` (for Minimised rows)
  - **Restore** chip for Minimised rows; no chip for Open rows
  - **Stop** button on the far right (small `■` icon, red-tinted on hover, tooltip *"Stop terminal"*) — kills the PTY. **Not** an × to avoid collision with the panel-header × (which means minimise).
- Click a row: Open → focus that window; Minimised → restore (re-open as a window).
- Footer hint: `Click row to focus · Stop ends the session`.

**2. Sessions list** *(extend `web/src/components/Home/index.tsx`)*

- **One new filter pill**: `N Live` (= Open + Minimised), inserted before the existing `waiting`. Hidden when count is 0. Two separate Open/Minimised filters are deliberately *not* added in v1 — the dot colour + chip make the distinction obvious within the list, and the topbar pill+popover already give you a filtered live-only view.
- Open rows: teal filled `.row-dot`, left-stripe `border-left: 2px solid #5eead4`, no chip.
- Minimised rows: purple outlined `.row-dot`, left-stripe `border-left: 2px solid #a78bfa`, **Restore** chip (click → restore window).
- **Live rows pin to the top** of the list regardless of `last_event_at`, then sort by `last_event_at` within the live group. Non-live rows sort by `last_event_at` as today. This keeps "what's live right now" visible even when an older session is still running quietly.

**3. Terminal panel header** *(modify `web/src/components/TerminalWindow.tsx`)*

- × now means **minimise**, not close.
- Tooltip on hover: *"Minimise terminal"*.
- Behaviour: dispatch `MINIMISE` (new) → drop window from `windows` state (same as today's CLOSE), but the PTY is left untouched and the topbar pill / sessions list pick it up.

### Data model

**`sessions` table — new columns** (additive ALTER, idempotent per existing convention):

| Column | Type | Meaning |
|---|---|---|
| `terminal_id` | `TEXT NULL` | The `ClaudePtyManager` terminal id this session is linked to, if any. Null when the PTY exits or no terminal was ever linked. |
| `terminal_attached_clients` | `INTEGER NOT NULL DEFAULT 0` | Count of currently-attached WS clients. `0` and `terminal_id IS NOT NULL` → *running*. `>0` → *attached*. `terminal_id IS NULL` → no live PTY. |

Both are denormalised projections of `ClaudePtyManager` state — the manager remains the source of truth in memory; the columns exist so the sessions API and the topbar pill can render without a second round-trip.

**Boot reset.** PTYs are in-memory only; nothing in the manager survives a server restart. So on boot, before the watcher / HTTP server start accepting traffic, run `UPDATE sessions SET terminal_id = NULL, terminal_attached_clients = 0 WHERE terminal_id IS NOT NULL OR terminal_attached_clients > 0` to clear any stale Open/Minimised indicators left from the previous run.

### Server changes

`server/src/claude-pty-manager.ts`:

- On `link(terminalId, sessionId)`: write `terminal_id` to the row.
- On `proc.onExit`: clear `terminal_id` and `terminal_attached_clients` on the linked row (if any).
- On WS `attach` / `detach`: update `terminal_attached_clients` for the linked row.
- Emit SSE events `terminal:attached` / `terminal:detached` / `terminal:exited` with `{ sessionId, terminalId, attachedClients }`.

`server/src/routes/sessions.ts` — extend the `GET /api/sessions` payload with `terminalId` and `terminalAttachedClients`, so the Sessions list and Topbar pill derive their state from the same fields.

`server/src/routes/terminals.ts`:

- `DELETE /api/terminals/:id` — unchanged (still kills). This is the path the popover **Stop** button hits.
- **No new `/restore` endpoint.** Restore is purely client-side: the client re-adds the window to the `windows` store and opens a fresh WS upgrade against the existing terminal id. The existing WS-upgrade route already returns 404 when the terminal id is gone, which the client renders as *"terminal no longer available — start a new one?"* via the existing resume flow.

`POST_EXIT_RETENTION_MS` (`server/src/claude-pty-manager.ts:17`) — bump from `30_000` to **15 minutes** now that *running* is first-class. Today's 30s assumed the user only ever wants a brief reconnect window; with explicit minimise it's reasonable to keep history around for the typical "I'll come back to it after lunch" pattern.

### Client changes

- **`web/src/stores/windows.ts`** — add `MINIMISE` action distinct from `CLOSE`. `MINIMISE` removes the window from state but does not call `DELETE /api/terminals/:id`. `CLOSE` (kept for non-terminal windows) is the legacy path.
- **`web/src/components/TerminalWindow.tsx`** — × dispatches `MINIMISE`. Update the tooltip.
- **`web/src/data/sessions-api.ts`** — `Session` shape gains `terminalId: string | null` and `terminalAttachedClients: number`.
- **`web/src/hooks/useTerminalPresence.ts`** *(new)* — single source of truth for "what's live"; merges the windows store with the sessions feed. Returns `{ attached: SessionId[], running: SessionId[], byId: Record<SessionId, PresenceInfo> }`. Consumed by:
  - `RunningTerminalsPill` (new) — renders the topbar pill + popover.
  - `Home/SessionsList` — renders the per-row state.
- **CSS** — extend `App.css` with `.row-dot--attached`, `.row-dot--running`, `.sr--attached`, `.sr--running`, `.sl-chip--restore`. Reuse existing pill styling for the new section-header counts.

### Interactions / edge cases

- **Two terminals open for the same session** — disallowed in v1. Attempting to open a second window for an already-attached session focuses the existing one (same behaviour as click-restore from the popover).
- **Click × on the panel while typing** — PTY input is a byte stream; the keystroke buffer in `node-pty` is not lost on detach. Smoke-test only; no special handling.
- **Network blip → WS reconnects** — `attached_clients` will briefly drop to 0 then come back. SSE consumers should debounce the *attached → running* transition by ~2s to avoid flicker.
- **Page reload** — `attached_clients` drops to 0 server-side immediately; row becomes *running*. When the page re-mounts and the window store is empty, it does not auto-re-attach — the row stays *running* until the user clicks restore. (Auto-restore is a future affordance; keep v1 explicit.)
- **PTY exits while running** — clear `terminal_id`, emit `terminal:exited`, row drops from popover and reverts to its underlying SessionState in the list.
- **PTY evicted from retention window** — popover row disappears silently. If the user later opens the underlying session and resumes, it goes through the normal `resume` flow (existing behaviour).

### Out of scope (v1)

- Multiple panels for the same PTY.
- Drag-to-reorder popover rows.
- Keyboard shortcuts (popover open, ↑↓, Enter). Planned for v1.1.
- Live thumbnail / peek-and-attach preview (post-1.0.0 per roadmap line 140).
- Cross-device awareness — Minimised terminals are local-only; remote-session indicators are a separate problem.
- Auto-re-attach on page reload.
- Tombstone rows for evicted PTYs in the popover (just remove the row).
- Separate Open / Minimised filter pills in the Sessions list (only one **Live** filter for v1).

## Open questions

1. **POST_EXIT_RETENTION_MS** — 15 minutes feels right for "Minimised" semantics, but a power user with many agents could accumulate dead PTYs holding scrollback in memory. Hard cap: 50 retained at a time, evicting oldest first.

## Implementation order

1. Schema migration + boot-time reset (`UPDATE sessions SET terminal_id = NULL, terminal_attached_clients = 0 …`).
2. `ClaudePtyManager` writes `terminal_id` / `terminal_attached_clients` on link / attach / detach / exit.
3. SSE events (`terminal:attached` / `terminal:detached` / `terminal:exited`) + sessions API field extension.
4. `useTerminalPresence` hook + `RunningTerminalsPill` + popover (client).
5. Sessions list row treatment + single `Live` filter pill (client).
6. Panel `MINIMISE` action + tooltip "Minimise terminal" (client).
7. Bump `POST_EXIT_RETENTION_MS` to 15 min + 50-retained cap (server).

## Acceptance tests

Smoke tests covering the core flow (mix of server unit tests + client integration):

- **Minimise keeps the PTY alive.** Open a terminal, send a few keystrokes to Claude, click × on the panel. The window is gone but the PTY is still running (verify via `ClaudePtyManager.terminals` membership and DB row showing `terminal_id IS NOT NULL`, `terminal_attached_clients = 0`).
- **Running pill appears after minimise.** Topbar pill renders `Running 1 ▾` after the minimise above. Hidden again after Stop.
- **Restore re-attaches the same PTY.** Click the popover row (or list `Restore` chip). The terminal window re-opens; scrollback retained; the very next keystroke reaches the same `node-pty` process (not a fresh one).
- **Stop kills the PTY.** Stop button in the popover row sends `DELETE /api/terminals/:id`, the row disappears, `terminal_id` clears on the session row.
- **Boot reset clears stale indicators.** Set `terminal_id` and `terminal_attached_clients = 3` directly in the DB, restart the server, assert both fields are reset to NULL / 0 before any HTTP traffic is accepted.
- **Live rows pin to top of Sessions list.** Insert an older session with an attached terminal alongside newer non-live sessions; assert the older live row comes first.
