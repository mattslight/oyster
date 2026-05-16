# cmd+K type filter — design

**Status:** Draft for review · 2026-05-16 · branch `cmdk-type-filter`

## Goal

Let the user narrow cmd+K results to a single entity type — **session**, **artefact**, or **memory** — and optionally a single **space**. Today cmd+K returns artefacts + transcripts in one flat list and never surfaces memories at all.

The user's two driver phrasings:

- *"I just want to find a session."*
- *"I just want to find a memory in tokinvest."*

## Current state

`web/src/components/SpotlightSearch.tsx`:

- Single text input, flat results.
- Two sources: artefact title fuzzy-match (client-side), transcript FTS (`/api/transcripts/search` via `searchTranscripts`).
- No memory source. No type filter. No space filter beyond what the surface already shows.

Memory backend is partially in place: `memory-store.ts` already runs FTS5 over `content` and `tags` (used by the MCP `recall` tool). There is **no** HTTP search endpoint — only `GET /api/memories` (list) and `POST /api/memories/reconcile`.

## Design

### Filter model

Two prefix characters, one value each, both optional:

| Prefix | Namespace | Cardinality | Value source |
|---|---|---|---|
| `@` | type | one of `session` \| `artefact` \| `memory` | fixed |
| `#` | space | space id | live `fetchSpaces` |

State shape:

```ts
type SpotlightFilter = {
  type: 'session' | 'artefact' | 'memory' | null;
  spaceId: string | null;
  query: string; // freeform text, excludes the consumed prefixes
};
```

A second `@type` token **replaces** the first (radio). Same for `#space`. No multi-value in v1 — explicitly out of scope below.

### Input mechanics

Render filter chips as siblings of the `<input>` inside the existing `.spotlight-input-row`, visually preceding the caret:

```
[🔍] [@memory ×] [#tokinvest ×] |caret typing here…
```

Interactions:

- Typing `@` opens the type-autocomplete popover anchored to the caret.
- Typing `@m` filters the popover to type names matching `m*`.
- `Enter` / `Tab` / mouse-click on a popover row commits: consumes the `@…` characters from the input, sets `filter.type`, renders the chip. Popover closes.
- `Esc` while popover is open closes it without consuming.
- `Backspace` at empty input removes the most-recently-added chip.
- `×` on a chip removes that filter.
- `#` works identically against the space namespace.

The input's visible string after commit is **just the query** — chips own the filter state. The placeholder text reads `Search artefacts, sessions, memories — type @ to filter`.

### Dropdown UI

Floating popover, ~200px wide, anchored under the caret. Two layouts depending on namespace:

**Type popover** — fixed 3 rows, with live counts once the query has at least one result fetch in flight:

```
@ memory     2
@ session    —
@ artefact   —
also try #space
```

**Space popover** — fuzzy-matched against `spaces` plus the legacy `home` / `__all__` virtual spaces, capped at 8 rows.

Counts come from the result-loading flow described below. Before counts arrive, render `—`.

### Browse-without-typing

The chip-row approach won this case in the comparison; we lose it with the dropdown. To recover it: when cmd+K opens with an **empty query**, render a single subtle hint row above results — *"Type @ to filter by type, # by space — or browse recent below"* — and below it the same "recent" feed the surface already shows (artefacts + recent sessions + recent memories, interleaved by `created_at`). This keeps cmd+K useful as a "what was I just doing" lookup, without adding a chip row.

When the user types `@` while query is empty, the popover opens normally and the recent feed dims.

### Results pipeline

For a given `(filter, query)`:

| filter.type | source(s) |
|---|---|
| `null` | all three, in parallel; merged by recency or section-headed (artefacts, sessions, memories) |
| `session` | `searchTranscripts` only |
| `artefact` | client-side fuzzy on `artifacts` only |
| `memory` | `/api/memories/search` (new — see Backend) |

`filter.spaceId` is applied as a post-filter on each source:

- **Artefacts** — already carry `spaceId`, filter client-side.
- **Transcripts** — `/api/sessions/search` does **not** currently accept a `space_id`. We add it. Server-side because the FTS `limit` is applied before filtering — client-side post-filter would return too few rows.
- **Memories** — same; the new `/api/memories/search` accepts `space_id` from day one.

When `filter.type === null`, results are grouped under section headers (`Sessions · 3`, `Artefacts · 7`, `Memories · 2`). These same counts populate the dropdown.

Keyboard nav (Up/Down/Enter) stays as today — flat ordered list across sections.

## Backend

**New route** in `server/src/routes/memories.ts`:

```
GET /api/memories/search?q=<query>&space_id=<optional>&limit=<8>
→ Memory[] (existing shape) ordered by FTS5 rank
```

Implementation reuses the existing FTS5 path in `SqliteFtsMemoryProvider.recall(...)` (memory-store.ts:609) — the MCP `recall` tool already exercises this code path; we're just exposing it over HTTP. Honor `superseded_by IS NULL` like `recall` does.

**Extend existing route** `/api/sessions/search` in `server/src/routes/sessions.ts:269` to accept an optional `space_id` query param and pass it through to `sessionStore.searchEvents`. If `sessionStore.searchEvents` doesn't currently filter by space, add that filter — sessions carry `space_id` (assignment_mode), so this is a `WHERE` clause addition on the FTS join.

No DB migrations.

## Out of scope (v1)

- Multi-value filters (`@memory @artefact`, `#a #b`). Single value each — revisit if asked.
- Additional namespaces (`!tag`, `~author`, `date:`). Design leaves room; not building.
- A click-to-open filter icon next to the search glass. The `@` keystroke is the only entry point. Revisit if discoverability data says otherwise.
- Live count refresh while typing. Counts fetched once per `(filter, query)` and cached; debounced same as today's transcript search (180ms).
- Memory writes from cmd+K. Read-only, matches existing memory API surface.
- Onboarding tour / first-open coachmark. Hint text in the placeholder is the only nudge in v1.

## Open assumptions worth flagging

1. **Default space scope = global.** No `#` chip means search across all spaces, not just the active one. Active space remains relevant only when an opened result lacks an explicit destination.
2. **Type token is mutually exclusive.** Picking `@memory` while `@session` is set replaces it. Saves us a "remove which one" UI.
3. **Recent feed on empty query is acceptable scope creep.** Mitigates the discoverability loss from removing the chip row. If considered out-of-scope, we drop it and keep cmd+K empty-on-open as today.

## Files touched

- `web/src/components/SpotlightSearch.tsx` — chips, popover, filter state, source dispatch
- `web/src/components/SpotlightSearch.css` (new, or extend `App.css`) — chip + popover styles
- `web/src/data/memories-api.ts` — add `searchMemories(q, { spaceId, signal })`
- `web/src/data/sessions-api.ts` — extend `searchTranscripts` to accept `spaceId`
- `server/src/routes/memories.ts` — add `GET /api/memories/search`
- `server/src/routes/sessions.ts` — extend `/api/sessions/search` to accept `space_id`
- `server/src/memory-store.ts` — expose FTS helper if not already public
- `server/src/session-store.ts` — accept `spaceId` in `searchEvents`

No changes to: `App.tsx` shortcut wiring, `ChatBar`, MCP surface, DB schema.

## Why this beat the alternatives

- **Persistent chip row** (4 always-visible pills) — more discoverable, but adds permanent chrome and can't extend to spaces (too many) without a second row. We lose the "browse" affordance and recover it with the recent feed.
- **Segmented tabs with counts** — strong "where did my hit go" signal, but heaviest chrome. Counts can live in the dropdown instead.
- **GitHub-style `type:memory`** — more uniform if we ever add 5+ namespaces, but 5× the keystrokes today and no natural autocomplete trigger character. Defer until we actually have a third namespace.
- **`/` instead of `@`** — collides with `/`-prefixed slash commands in the ChatBar.
