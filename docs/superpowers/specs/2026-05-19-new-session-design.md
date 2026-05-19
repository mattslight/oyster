# New session affordance — design

**Status:** Draft for review · 2026-05-19 · branch `new-session` (based on `main` post-terminal-minimise merge)

## Goal

Make "start a fresh Claude session" reachable from anywhere in Oyster. Today the only entry point is *Launch Claude here* on a project tile's `⋯` menu, which requires being on Home, in the right space, and knowing which tile maps to the folder you want.

The requirement (user verbatim):

> Also need to be able to start a new fresh session, if we are on home it should ask which space / project to start in (it will start in the current active cwd).

Translated:

1. Be reachable from any view that renders the breadcrumb topbar (Home, every space view).
2. Inside a space: behave intelligently — don't ask if there's only one project; ask if there are several.
3. On Home: ask which space → project to start in.

## Current state

**Existing spawn path** (`web/src/App.tsx:395`, `web/src/components/Home/ProjectTile.tsx:155`, `server/src/routes/terminals.ts:163`): `Launch Claude here` on a project tile → `handleLaunchClaudeFromProject(projectId)` → `launchAndOpen({ kind: "claude_new", source: { type: "project", id } })` → `POST /api/terminals` → server resolves cwd via `resolveSourceCwd` from the trusted project row → spawns `claude` via `ClaudePtyManager` → returns `terminalId` → client dispatches `OPEN_CLAUDE_TERMINAL`.

This route never accepts a client-supplied `cwd` (`routes/terminals.ts:179`): only typed `source` references (project / session / remote_session). We will reuse this contract unchanged.

**Existing folder attach** (`web/src/components/Home/AttachFolderForm.tsx`, `web/src/data/projects-api.ts:40`): user types a path → `POST /api/projects/attach-folder` (idempotent — creates project or adopts existing `.oyster/id`) → returns a Project. The escape hatch in this design reuses this verbatim and does not introduce a new browser-side folder picker.

**Existing topbar pill** (`web/src/components/Topbar/RunningTerminalsPill.tsx`, mounted in `web/src/components/Home/index.tsx:823`): `● N running ▾`, hidden when count is 0, sits inside `.home-breadcrumb-inner--running` at the right edge of the breadcrumb nav. The new pill is its sibling.

**Projects API** (`web/src/data/projects-api.ts:23`): today only per-space — `GET /api/projects?space_id=…`. We need a flat all-projects endpoint for the palette.

## Design

### 1. Affordance + placement

A new pill **`+ New session`** in the breadcrumb nav, right-aligned alongside the existing `● N running ▾` pill. When no terminal is running, only the new pill is visible at the right edge; the running pill inserts to its left when `totalLive > 0`.

```
[Home] [Oyster] [+ Add space]  ……………………  [● 2 running ▾] [+ New session]
```

- Same DOM neighbourhood as the running pill (`home-breadcrumb-inner` ancestor); same visual treatment so the cluster reads as a unit.
- Always visible — does not depend on session state. Hidden alongside the breadcrumb in views that don't render it.
- Disabled state: never. Even when there are zero projects with live folders, the pill still opens the palette so the user can attach a folder.

### 2. Keyboard shortcut

`⌘/` (Ctrl+/ on non-Mac) opens the palette from anywhere. **Unconditional intercept** — the handler always `preventDefault`s, regardless of focus context (including text inputs, textareas, contenteditable nodes, xterm.js helper textareas, etc.).

Picking a shortcut for "new session" was harder than expected. `⌘N` and `⌘E` (the two obvious mnemonic-friendly choices) were both rejected:

- `⌘N` — Chrome reserves it at the OS level for *new window*; the keystroke never reaches the page, so `preventDefault()` cannot intercept it. Same for `⌘T`, `⌘W`, `⌘Q`, `⌘L`, `⌘D`, `` ⌘` ``.
- `⌘K` — already bound to Spotlight search in Oyster.
- `⌘E` — collides with the Claude-in-Chrome browser extension (a likely co-installed companion).

`⌘/` has no Chrome reserved use, no macOS reserved use, no Oyster conflict, and isn't claimed by the Claude-in-Chrome extension. Weak mnemonic ("slash command-style entry"), but reliable. Single-letter combos were preferred over chords for typability; we accept that `⌘/` may need revisiting if it later conflicts with something on a user's machine, in which case making the shortcut user-configurable is a natural next step (deferred — out of scope for v1).

The handler installs once in `App.tsx` (window-level listener), not inside the picker. The `keydown` event fires before any focused element processes the key, so the intercept is reliable for any combo Chrome actually delivers.

### 3. The picker — command palette modal

A centered modal (`web/src/components/NewSessionPicker.tsx`). Built from scratch — Oyster does not currently have a generic palette primitive to reuse.

```
┌─ Search projects…                         ⌘N ─┐
│                                                │
│  RECENT                                        │
│  ▸ oyster-dev          Oyster · ~/Dev/…        │
│  ▸ blunderfixer        Home · ~/Dev/…          │
│                                                │
│  ALL PROJECTS                                  │
│  ▸ terminal-minimise   Oyster · ~/Dev/…/…      │
│  ▸ old-spike (no folder, disabled)             │
│                                                │
│  Or pick a folder…  ← quiet, secondary         │
│                                                │
│  ↑↓ nav   ↵ start   esc close                  │
└────────────────────────────────────────────────┘
```

**Behaviour:**

- Opens on pill click OR `⌘N`.
- Single text input at the top filters across `project.name` + `project.recentPath` + `space.name`. Case-insensitive substring match (no fuzzy scoring v1 — keep it predictable).
- **Recents:** localStorage cache (`oyster-new-session-recents`) keyed `projectId`. Updated on successful spawn. Last 5, LRU. Server-side recent tracking is explicitly out of scope.
- **"No folder" projects** (those with `hasLivePath === false`) are rendered disabled with a tooltip — visible so the user understands they exist, un-clickable so they can't trigger a spawn that the server would reject with `project_homeless`.
- **Active space pre-scope:** when invoked from inside a space (and not via `⌘K`-style global mode — see below), the palette opens with the search box pre-filled with the space name. The user can clear it to broaden the search. This is the visual signal that they're starting "in this space" by default. No separate filter chip.
- **Keyboard:** `↑↓` moves the highlight (skipping disabled rows), `↵` activates the highlight, `esc` closes.

### 4. Routing logic

When the pill or `⌘N` fires:

```
on Home?
  └─ yes → open palette (no pre-fill)
  └─ no  → active space has how many live-folder projects?
            ├─ 0  → open palette (no pre-fill) — they can pick elsewhere or attach a folder
            ├─ 1  → spawn silently in that project's cwd (no palette)
            └─ 2+ → open palette pre-scoped to the active space
```

The pre-scope is implemented purely as initial search text (see §3). Clearing it widens the search.

Activation of a project row:

1. Persist the projectId to the recents LRU.
2. Call `launchAndOpen({ kind: "claude_new", source: { type: "project", id } }, dispatch)` — the existing helper.
3. On success, close the palette. The TerminalWindow renders via the existing dispatch path.
4. On error, render the message inline (do not close) so the user can retry without re-finding the project.

### 5. "Or pick a folder" escape hatch (quiet)

Secondary affordance. Visually subdued — a small text link below the project list, *not* a featured row.

Selecting it expands an inline path-input row (same UX shape as `AttachFolderForm`):

```
Or pick a folder…
  ┌───────────────────────────────────┐
  │ /absolute/path or ~/relative      │
  └───────────────────────────────────┘
  [ on Home: ] Add to space: [Oyster ▾]
  [ Cancel ]  [ Start session ]
```

**Flow:**

1. User types/pastes a path. On Home, picks a space from existing real spaces (no default fabrication).
2. Submit → `attachFolder(spaceId, path)` (existing endpoint, idempotent).
3. On success → use the returned `project.id` and continue through the normal spawn path (steps 2-4 of §4).
4. Errors: surface inline in the same row; don't dismiss the palette.

**Constraint:** on Home, the dropdown lists only **real existing spaces** — meta-spaces (`__all__`, `__archived__`) are filtered out. If the user has zero real spaces, the dropdown is replaced with a one-line nudge: *"Add a space first."* (See §6.) We deliberately do not auto-create a "Home" space here — the second-opinion review flagged hidden side-effects, and avoiding magic keeps the spec aligned with Oyster's "no surprises" stance.

### 6. Empty / edge states

| State | What the palette shows |
|---|---|
| No spaces, no projects | Empty list, folder picker not yet exposed (no space to attach to). One-line copy: *"Create or attach a project to start a session."* with an inline **+ Add space** CTA that opens the existing add-space flow. Once at least one real space exists, the folder escape hatch becomes available on the next open. (Pill itself stays clickable; we don't hide it — discoverability over silence.) |
| Spaces exist but all projects are "no folder" | All projects rendered disabled with tooltips. Folder escape hatch fully functional (real spaces in the dropdown). |
| Live terminal already running in the same cwd | No warning — two claude procs are allowed in the same cwd (per handover note). The new spawn appears as a separate row in the running pill. |
| `claude` binary missing | Inline error in the palette ("Couldn't start Claude…") + the existing `installHint` (`npm install -g @anthropic-ai/claude-code`). |
| Network / server error | Inline error; palette stays open. |
| Spawn cap reached (`too_many_terminals`) | Inline error pointing user to stop a running terminal first. |

### 7. Data model + API

**One new server endpoint:** `GET /api/projects` (no query params) → flat list of all projects across all spaces.

```ts
// Response: Array of:
{
  id: string;
  spaceId: string;
  name: string;
  recentPath: string | null;
  hasLivePath: boolean;
  isGitRepo: boolean;
  createdAt: string;
  // (existing Project shape from project-service.ts)
}
```

Today `GET /api/projects?space_id=…` is per-space. The new flat form is the simplest delta — same handler, drop the filter when `space_id` is absent. No new table, no new column, no migration.

**Client hook:** `useAllProjects()` (`web/src/data/projects-api.ts`) — wraps the flat endpoint, returns `{ projects, loading, error, refresh }`. Cached in memory while the palette is open; fetched fresh on open (cheap query, no need for live updates inside the palette).

### 8. Client component map

| File | Purpose |
|---|---|
| `web/src/components/NewSessionPicker.tsx` *(new)* | The modal. Renders search + grouped list + folder escape hatch. |
| `web/src/components/Topbar/NewSessionPill.tsx` *(new)* | The `+ New session` pill. Mirrors `RunningTerminalsPill`'s visual API. |
| `web/src/components/Home/index.tsx` *(modify)* | Mount the new pill next to the running pill. Adjust right-align styling so the cluster stays right-edged whether 1 or 2 pills are visible. |
| `web/src/App.tsx` *(modify)* | Lift `handleLaunchClaudeFromProject` to a stable callback (already is — keep). Add a `useNewSessionPicker()` mount + `⌘N` global handler. Pass `onLaunchClaude` + `activeSpace` + all-projects data into the picker. |
| `web/src/data/projects-api.ts` *(modify)* | Add `fetchAllProjects()` + `useAllProjects()` hook. |
| `web/src/data/recents.ts` *(new, tiny)* | localStorage LRU for recents. ~30 lines. |

CSS: extend `App.css` (or a new `NewSessionPicker.css` colocated with the component if the existing file is overgrown) with `.nsp-modal`, `.nsp-search`, `.nsp-row`, `.nsp-row--disabled`, `.nsp-folder-link`, `.nsp-folder-form`.

### 9. Interactions / edge cases

- **Two palettes at once:** impossible — the picker is conditionally rendered from `App.tsx` and bound to a single `open` state.
- **Palette open while a spawn is in-flight:** disable the highlighted row until the API responds. Other rows remain clickable (cheap to retry against the same flight if user gets impatient — but probably not worth the complexity; lock the whole list during in-flight for v1).
- **Palette open across SSE-driven project updates:** the in-memory snapshot is stable for the open duration. Reopening refreshes. Don't try to live-merge — adds complexity for no real win.
- **Active space changes while palette open:** rare. Don't try to re-scope — the user explicitly opened the palette from a context; let them complete the action they started.
- **No projects, no spaces, user clicks pill:** palette opens, shows the empty-state copy. The folder escape hatch only appears when there's at least one real space to attach to.
- **Filter empties the list:** show "No projects match" inline; folder escape hatch still visible.

### 10. Future hooks (deliberately not built in v1)

- **Agent dropdown** on the pill / palette — a `[Claude ▾]` split-button or a row of agent chips. Today everything is Claude; surfacing the choice prematurely promises a feature the UI can't deliver. Spec note: the `POST /api/terminals` body already carries `kind`; an `agent` field would be the natural extension point.
- **Server-side recents** — if we ever want recents to sync across browsers/devices, the right move is a small `user_preferences` row, not bolting it onto the sessions table. Out of scope.
- **Resume picker** — different surface, different problem (the existing Sessions list and Inspector handle this). Not unified here.
- **Workspace-style cmd+K** — a broader command palette covering nav, search, settings, etc. would subsume `⌘N` as a special-case row. Out of scope; `⌘N` lives standalone for now.

## Out of scope (v1)

- Server-side recents persistence.
- Multi-agent (opencode / future agents) selection.
- Resume / attach in this picker (Sessions list owns that).
- Generic command-palette framework.
- Fuzzy search ranking; substring filter is v1.
- Drag-to-reorder recents; LRU is the only ordering.
- Auto-creation of any space when none exists.
- Browser-native folder picker (`showDirectoryPicker` / `<input webkitdirectory>`) — typed path matches existing Oyster convention.

## Implementation order

Suggested sequence — the writing-plans phase will break each step into independently-mergeable subtasks.

1. **Server**: drop the `space_id` requirement on `GET /api/projects` (handler change only, no schema work). Add a tiny test asserting the flat shape.
2. **Client data**: `fetchAllProjects()` + `useAllProjects()` hook.
3. **Recents primitive**: localStorage LRU module + unit test.
4. **`NewSessionPicker` component**: render-only — list + search + keyboard nav + disabled rows. No spawn yet; click is a no-op. Visual review checkpoint.
5. **Wire spawn**: hook `onActivate` to `handleLaunchClaudeFromProject`. Smoke-test that picking a project starts a terminal.
6. **Folder escape hatch**: inline path input + space dropdown (where relevant) + attach-then-spawn flow.
7. **`NewSessionPill`**: render the pill, right-aligned with the running pill in the breadcrumb. Both pills cluster at the right edge.
8. **Smart routing**: `⌘N`/pill-click decides palette-vs-spawn based on active space + project count.
9. **`⌘N` global handler** — unconditional intercept (matches §2 and the acceptance test). No focus-aware guard.
10. **Empty-state copy + edge-case polish**.
11. **CHANGELOG entry** in the same PR (per `CLAUDE.md` convention).

## Acceptance tests

Smoke tests covering the core flow:

- **Pill is visible everywhere the breadcrumb renders.** Mount Home, mount a space view, mount `/sessions/:id` — assert the pill DOM is present in each.
- **Pill click on Home opens the palette.** Assert the modal is mounted, no pre-fill in the search.
- **Pill click in a single-project space spawns silently.** Mount a space with one live-folder project; click the pill; assert `POST /api/terminals` was called with the right project source and the palette was *not* opened.
- **Pill click in a multi-project space opens the palette pre-scoped.** Search input value matches the active space name.
- **`⌘N` opens the palette unconditionally.** From Home, from a space view, and while focus is inside any `<input>`, `<textarea>`, or `contenteditable` node. Browser's "new window" default never fires inside Oyster.
- **Search filters substring on name, path, and space name.**
- **Disabled rows don't activate.** Click a `hasLivePath === false` row → nothing happens.
- **Recents persist across reloads.** Spawn into a project, reload, reopen palette → that project is in the RECENT section.
- **Folder escape hatch attaches then spawns.** Provide a path, pick a space (or use the only one), submit; assert `attachFolder` is called then `launchAndOpen`.
- **Empty state on a fresh install.** No spaces, no projects, click pill → palette renders empty-state copy *"Create or attach a project to start a session."* with the **+ Add space** CTA; folder row not exposed.
- **Server-error rendering.** Mock `POST /api/terminals` returning `binary_not_found`; assert inline error renders with install hint.

## Open questions

None outstanding for v1. (The agent-dropdown and server-recents items are explicitly deferred per §10.)
