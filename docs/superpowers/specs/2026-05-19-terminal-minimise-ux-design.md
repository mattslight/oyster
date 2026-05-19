# Terminal minimise UX — design

**Status:** Draft for review · 2026-05-19 · branch `terminal-minimise-ux`

## Goal

When the user clicks × on an embedded Claude Code terminal panel, *minimise* the panel — keep the PTY alive on the server, and surface a clearly discoverable affordance to restore it. Today × silently removes the panel from `windows` state while the PTY keeps running with no way to re-find it.

The user's mental model: *"Like macOS dock / Windows taskbar — I can see what's running, click to come back, click × on the listed item to actually kill it."*

## Current state

**Close handler** (`web/src/components/TerminalWindow.tsx:13,169`, `web/src/App.tsx:602`): × calls `onClose` → `dispatch({ type: "CLOSE", id })` → `windows.ts:114` removes the window from state. The WebSocket closes. The PTY keeps running on the server.

**Server PTY lifecycle** (`server/src/claude-pty-manager.ts:98-283`): `ClaudePtyEntry` tracks `exitedAt` (null = running), `clients: Set<WebSocket>` (attached browser connections), `evictTimer` (auto-delete 30s after exit). `linkedSessionId` exists in memory after auto-link but is not persisted to the `sessions` table. `DELETE /api/terminals/:id` (`routes/terminals.ts:307`) calls `kill()` → `proc.kill()` + schedule eviction.

**Sessions list** (`web/src/components/Home/index.tsx:107-135`) renders pills `live · waiting · done · all` derived from `SessionState = "active" | "waiting" | "disconnected" | "done"` (`shared/types.ts:82`). State changes via JSONL ingest. **No concept of "a live terminal is attached"** — the list has no idea PTYs exist.

**No dock / tray / persistent indicator.** Closing the panel is the last visible touchpoint with that PTY until the user happens to wander into the Sessions list.

**Roadmap note** (`docs/plans/roadmap.md:140`): a future "peek-and-attach view" is mentioned for issue #470 (post-1.0.0). This spec lays the data-model groundwork for it.

## Design

### Two new live states

| State | Meaning | Visual | Where chip appears |
|---|---|---|---|
| **attached** | PTY alive, a window is open in front of the user | filled teal dot `#5eead4`, left accent stripe | popover + sessions list (no chip — being looked at is its own affordance) |
| **running** | PTY alive, no window open (backgrounded) | outlined purple dot `#a78bfa`, left accent stripe | popover + sessions list (`restore` chip) |

These compose with the existing `SessionState`. A session is e.g. *waiting AND attached* if Claude is awaiting input and the panel is open. Visually we lead with the live-state (teal/purple) when present and fall back to the existing yellow/grey dot when absent.

### Three surfaces

**1. Topbar pill** *(new)* — `web/src/components/Topbar/RunningTerminalsPill.tsx`

```
⏵ Running 2 ▾
```

- Single teal pulse + count. Hidden entirely when `count === 0`.
- Click opens a popover anchored to the pill.
- Popover lists one row per live PTY:
  - filled teal dot (attached) or outlined purple dot (running)
  - title (session title, ellipsised)
  - meta line: `<space> · claude-code · <activity>` where `<activity>` is `cooking <Ns>` / `waiting for input` / `idle <duration>` / `minimised <Ns>` (for running rows)
  - chip on the right: `restore` for running rows, nothing for attached
  - × at the far right kills the PTY
- Click a row: attached → focus that window; running → restore (re-open as a window).
- Footer hint: `Click row to focus · × kills the PTY`.

**2. Sessions list** *(extend `web/src/components/Home/index.tsx`)*

- Two new filter pills: `N attached · N running` between the existing `waiting` and `done`. Both hidden when their count is 0.
- Attached rows: teal filled `.row-dot`, left-stripe `border-left: 2px solid #5eead4`, no chip (the dot says enough).
- Running rows: purple outlined `.row-dot`, left-stripe `border-left: 2px solid #a78bfa`, `restore` chip (click → restore window).
- Rows naturally sort to the top via `last_event_at` since live PTYs update activity continuously.

**3. Terminal panel header** *(modify `web/src/components/TerminalWindow.tsx`)*

- × now means **minimise**, not close.
- Tooltip on hover: *"Minimise (Claude keeps running)"*.
- Behaviour: dispatch `MINIMISE` (new) → drop window from `windows` state (same as today's CLOSE), but the PTY is left untouched and the topbar pill / sessions list pick it up.

### Data model

**`sessions` table — new columns** (additive ALTER, idempotent per existing convention):

| Column | Type | Meaning |
|---|---|---|
| `terminal_id` | `TEXT NULL` | The `ClaudePtyManager` terminal id this session is linked to, if any. Null when the PTY exits or no terminal was ever linked. |
| `terminal_attached_clients` | `INTEGER NOT NULL DEFAULT 0` | Count of currently-attached WS clients. `0` and `terminal_id IS NOT NULL` → *running*. `>0` → *attached*. `terminal_id IS NULL` → no live PTY. |

Both are denormalised projections of `ClaudePtyManager` state — the manager remains the source of truth in memory; the columns exist so the sessions API and the topbar pill can render without a second round-trip.

### Server changes

`server/src/claude-pty-manager.ts`:

- On `link(terminalId, sessionId)`: write `terminal_id` to the row.
- On `proc.onExit`: clear `terminal_id` and `terminal_attached_clients` on the linked row (if any).
- On WS `attach` / `detach`: update `terminal_attached_clients` for the linked row.
- Emit SSE events `terminal:attached` / `terminal:detached` / `terminal:exited` with `{ sessionId, terminalId, attachedClients }`.

`server/src/routes/sessions.ts` — extend the `GET /api/sessions` payload with `terminalId` and `terminalAttachedClients`, so the Sessions list and Topbar pill derive their state from the same fields.

`server/src/routes/terminals.ts`:

- `DELETE /api/terminals/:id` — unchanged (still kills). This is the path the popover × hits.
- `POST /api/terminals/:id/restore` — *new*. Re-opens the panel client-side; on the server this is a no-op except to validate the terminal still exists (returns 404 if it was evicted).

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
- **PTY evicted from retention window** — popover row gets a tombstone state (`exited 14m ago`) for ~30s then disappears; clicking it offers to start a fresh session via the existing `resume` flow. *Spec note: v1 may skip the tombstone and just remove the row — call out as an open question.*

### Out of scope (v1)

- Multiple panels for the same PTY.
- Drag-to-reorder popover rows.
- Keyboard shortcuts for popover navigation (planned for v1.1 — `⌘⇧T` to open, `↑↓` + `Enter`).
- Live thumbnail / peek-and-attach preview (post-1.0.0 per roadmap line 140).
- Cross-device awareness — running terminals are local-only; remote-session indicators are a separate problem.
- Auto-re-attach on page reload.

## Open questions

1. **Tombstone for evicted PTYs** — should an exited row linger in the popover for ~30s, or vanish immediately? Linger gives the user a "wait, what happened" moment but adds state to manage. Default: vanish immediately; revisit if users miss the signal.
2. **POST_EXIT_RETENTION_MS** — 15 minutes feels right for "running" semantics, but a power user with many agents could accumulate dead PTYs holding scrollback in memory. Hard cap: 50 retained at a time, evicting oldest first.
3. **Naming** — *attached / running / minimised* are coherent but verbose in mixed contexts. Alternatives: *open / background*, *foreground / background*. Current pick: stick with *attached / running* since they mirror existing PTY-manager vocabulary.

## Implementation order

1. Schema + `ClaudePtyManager` denormalisation (server) — covered by a single test in `server/test/`.
2. SSE events + sessions API field extension (server).
3. `useTerminalPresence` hook + `RunningTerminalsPill` (client).
4. Sessions list row treatment (client).
5. Panel `MINIMISE` action + tooltip (client).
6. Bump `POST_EXIT_RETENTION_MS` + add the 50-retained cap (server).
