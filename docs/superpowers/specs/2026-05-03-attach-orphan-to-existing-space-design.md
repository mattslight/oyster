# Attach orphan folder to an existing space

## Problem

On the Unsorted view (Home + Elsewhere), each orphan folder tile — a `cwd` with active sessions but no attached source — has a `FolderPlus` button that one-shots the folder into a brand-new space (`promoteFolderToSpace` → `POST /api/spaces/from-path`).

There is no way from this surface to attach the folder to a space that already exists. If the user has an "Oyster" space and a worktree at `~/Dev/oyster-os.worktrees` shows up under Unsorted, the only available action creates a duplicate "Oyster-os.worktrees" space instead of joining the existing one.

## Goal

Replace the single-shot `FolderPlus` action with a small popover that lets the user choose a destination space — existing or new — for the orphan folder, with a smart "Best match" suggestion when the folder name resembles a known space.

## Non-goals

- Keyboard navigation in the picker beyond Escape to close
- Fuzzy matching across deep folder paths (only the basename participates in scoring)
- Multi-select / bulk attach across orphan tiles
- Changing how `/attach` works from the chat bar (only the side-effect parity fix below applies)
- Any change to artifact tiles, Home cards, or the chat bar

## UX

Click `FolderPlus` on an Unsorted folder tile → popover anchored to the button, opening below the button and aligned to its right edge. If it would clip the viewport's right edge, align to the left edge instead; if it would clip the bottom, flip above the button. Clicking the same `FolderPlus` again toggles the popover closed.

```
┌─────────────────────────────────────────┐
│ Attach …/oyster-os.worktrees to        │
├─────────────────────────────────────────┤
│ ● Oyster                  Best match    │
├─────────────────────────────────────────┤
│ ● Blunderfixer                          │
│ ● Tokinvest                             │
├─────────────────────────────────────────┤
│ + New space                             │
└─────────────────────────────────────────┘
```

Sections:
- **Header**: `Attach <middle-truncated path> to` — the path uses middle-ellipsis so the basename always remains visible.
- **Best match** (optional): the highest-scoring space (score ≥ 1, see Smart match below), with a `Best match` caption on the right. Omitted when there is no qualifying match.
- **Other spaces**: every remaining non-meta space (excluding `home`, `__all__`, `__archived__`, and the best match) sorted alphabetically by `displayName`. Each row: colour dot + display name.
- **Divider**.
- **`+ New space`**: invokes today's promote behaviour (`promoteFolderToSpace(path)`).

Behaviour:
- Clicking a space row → `addSpaceSource(spaceId, path)`. On success, popover closes; the orphan tile disappears from Unsorted because the backend backfill (see "Backend symmetry" below) re-attributes its sessions and an SSE refresh fires.
- Clicking `+ New space` → `promoteFolderToSpace(path)`. Same close-on-success behaviour.
- On error, an inline error row renders inside the popover (e.g. `Path is already attached to space "Foo"`); the popover stays open so the user can pick something else.
- During the in-flight request, every row is disabled and the picked row shows a subtle pending state (no spinner, just `aria-busy` + opacity). Only one in-flight attempt at a time per popover.
- Closes on: outside click, `Escape`, after success.
- Empty space list (no spaces exist yet) → popover collapses to just `+ New space` plus a one-line hint.

The existing `promotingCwd` state in `Home/index.tsx` (line 159) is repurposed to gate the popover trigger and the in-flight row, so concurrent attempts across different tiles remain safely disabled.

## Smart match

Pure helper, no IO. Inputs: `folderBasename: string` and `spaces: { id, displayName }[]`. Output: the best-scoring space, or `null`.

Algorithm:
1. Lowercase both sides.
2. Tokenise on `/[^a-z0-9]+/` → array of non-empty tokens.
3. For each space, score against the folder tokens. For each folder token, take the best match across all space tokens (no double-counting per folder token):
   - `1.0` if any space token is exactly equal.
   - else `0.5` if any space token is a substring of the folder token, or vice versa.
   - else `0`.
   Sum across folder tokens.
4. Return the space with the highest score where score ≥ 1. Ties: return the space with the shorter `displayName` (favours the more general match — "Oyster" over "Oyster-prototype"). Further ties: alphabetical, so the result is deterministic.

Worked example: folder `oyster-os.worktrees` → tokens `[oyster, os, worktrees]`. Space "Oyster" → tokens `[oyster]`. `oyster == oyster` → score 1. Returns "Oyster". Space "Blunderfixer" → score 0. Filtered out.

Edge cases:
- Reserved/meta spaces (`home`, `__all__`, `__archived__`) are excluded by the caller before scoring.
- If two spaces tie at the top, the shorter-name rule deterministically picks one — no flicker between renders.

The helper lives at `web/src/components/Home/match-space.ts`. Trivial enough that a unit test is optional; if added, it sits alongside as `match-space.test.ts`.

## Backend symmetry

Today, `POST /api/spaces/from-path` does two things that `POST /api/spaces/:id/sources` does not:

1. Calls `sessionStore.backfillSourceForCwd(resolved, spaceId, sourceId)` to re-attribute orphan sessions whose `cwd` matches.
2. Broadcasts `session_changed` so connected clients refetch sessions.

Without these, attaching a folder to an existing space leaves the orphan sessions stranded — the Unsorted tile would not disappear, defeating the whole flow.

Changes:
- `server/src/space-service.ts` — in `addSource`, after the successful insert/restore, call `this.sessionStore.backfillSourceForCwd(resolved, spaceId, source.id)`. The no-op return path (path already attached to *this* space) skips the backfill — by definition there is nothing to migrate.
- `server/src/routes/spaces.ts` — in the `POST /api/spaces/:id/sources` handler, call `broadcastUiEvent({ version: 1, command: "session_changed", payload: { id: "" } })` after `addSource` returns, mirroring the from-path route.

This makes the side-effects of `addSource` identical to `createSpaceFromPath` (both end with backfill + broadcast). It also retroactively fixes the same gap for the chat-bar `/attach` flow and the `AttachSourceForm` UI — both currently leave orphan sessions behind, which is a latent bug rather than a deliberate behaviour.

## Files touched

| File | Change |
| --- | --- |
| `web/src/components/Home/index.tsx` | Replace direct promote `onClick` (~line 720–740) with popover open/close; pass `spaces` and the new attach handler down |
| `web/src/components/Home/AttachOrphanPopover.tsx` *(new)* | Popover component: header, best-match row, alphabetical list, `+ New space` row, error row, outside/Escape close |
| `web/src/components/Home/match-space.ts` *(new)* | Pure scoring helper described above |
| `web/src/components/Home/Home.css` | Popover styles only; no changes to the existing `home-active-project-tile--orphan` rules |
| `server/src/space-service.ts` | Backfill call inside `addSource` after successful insert/restore |
| `server/src/routes/spaces.ts` | Broadcast `session_changed` after `POST /api/spaces/:id/sources` succeeds |
| `CHANGELOG.md` | One bullet under Added / Changed |

No new dependencies. No DB migrations.

## Error handling

The only expected error path is `addSource` rejecting because the path is already attached to a different active space — surfaced verbatim in the popover. Network / unexpected errors render a generic `Couldn't attach folder` line with the original message in `title=`, matching how the rest of `Home/index.tsx` reports failures.

## Testing

- Manual: start a Claude Code session in an unattached folder so it appears in Unsorted; click `FolderPlus`; verify the popover opens, smart match works for a name-matching space, picking that space attaches and removes the tile, picking `+ New space` falls back to today's flow, picking an already-owning space surfaces the inline error.
- No automated browser tests exist for this surface today; do not add any solely for this change.
- Unit-test `match-space.ts` if convenient; the function is small and pure.

## Out of scope (explicitly)

- Search-as-you-type filter inside the popover (only useful at >10–15 spaces, which no user has yet)
- Drag-and-drop from orphan tile to a space pill (a much larger DnD investment)
- Showing the same picker on the existing `AttachSourceForm` flow (different surface, different interaction)
