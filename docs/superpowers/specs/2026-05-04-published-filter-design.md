# #374 — Published filter pill on Home

## Goal

Add a `N published` pill to the Artefacts header on Home alongside the existing `all` / `mine` / `from agents` / `linked` pills. Clicking it filters the artefact grid to currently-live publications.

Issue: <https://github.com/mattslight/oyster/issues/374>

## Why now

R5 (#315 backend, #316 viewer, #317 publish UI) shipped publication end-to-end. There's no entry point on the surface for "show me only my published artefacts" — they're scattered through the same grid as everything else, only marked by the per-tile `PublishedChip`. A pill closes that gap with the smallest possible UI change.

## Out of scope

- Standalone "Publications" management dashboard (deferred to #382)
- Per-publication metrics — view counts, last-viewed-at, copy-link clicks (also #382)
- Bulk unpublish
- Splitting open vs password mode in the pill itself — the per-tile chip already shows lock + amber for password mode, splitting the pill duplicates that signal

## Design

### Pill copy and treatment

- **Copy:** `published`. Matches the chip text, the data field name (`publication`), and reads consistently with the verb the user just used in the publish picker.
- **Inactive treatment:** neutral pill background (same as siblings) with a small purple pip prefix. Borrows the pip pattern from the Sessions section (`live` / `waiting` / `disconnected`) so the eye reads "this is a status, not an origin" without breaking the row's visual uniformity.
- **Active treatment:** existing `.stat-btn.active` purple — no new behaviour.
- **Hide-when-zero:** the origin pills (`mine`, `from agents`, `linked`) hide at 0 to keep the row tidy. The `published` pill stays visible at 0 because it doubles as a discoverability surface — clicking it before the user has published anything lands on a how-to hint instead of an empty grid. The `all` pill stays unconditional.

The purple is `#a78bfa`, matching `PublishedChip__tag` in `web/src/components/PublishedChip.css`.

### Filter model

The pill joins the existing `artefactSource` radio as a fifth value. Selecting `published` deselects the origin filter; selecting any origin deselects `published`. One state, mutually-exclusive.

Composable filtering ("from agents AND published") is rejected for now — it goes beyond the issue's acceptance, doubles the state, and forces the pill to look visually different from its peers.

The type name `ArtefactSource` slightly mis-fits with `published` included (a status, not an origin). Renaming touches more files than the change justifies; the union extension is one line. A follow-up rename can happen if more status filters land.

### Predicate

Define once locally in `Home/index.tsx`, mirroring `PublishedChip`:

```ts
const isLivePublication = (a: Artifact) =>
  a.publication != null && a.publication.unpublishedAt == null;
```

Use the same reference for both the count memo and the filter memo. Single source of truth, no inline duplication.

### Live updates

Already covered. `artifact_changed` SSE fires from the publish HTTP route and the MCP tools. App's `loadArtifacts()` refetches on receipt; the count memo and filter memo both depend on `effectiveDesktopProps.artifacts`, so they update on the next render. No new SSE wiring.

## Files touched

Three:

| File | Change |
|---|---|
| `web/src/components/Home/types.ts` | Extend `ArtefactSource` union with `\| "published"` (one-line) |
| `web/src/components/Home/index.tsx` | Add `"published"` to `ARTEFACT_SOURCE_ORDER` (last) and `ARTEFACT_SOURCE_LABELS`; extend `artefactSourceCounts` memo with the live-publication tally; extend `filteredArtefacts` memo with the `published` branch; render the purple pip in the JSX |
| `web/src/components/Home/Home.css` | Add `.pip-published { background: #a78bfa; }` |

No backend changes. No `shared/types.ts` changes — the wire format already carries `publication`.

## Acceptance

Manual, against a running dev server with the user signed into Pro:

1. Surface starts with no publications. Pill renders as `0 published` with the purple pip — visible but inactive.
2. Click `published` while count is 0. Grid is replaced by a how-to hint: "No published artefacts yet — type `/p <name>` in the chat bar, or right-click any artefact and choose **Publish…**".
3. Publish two artefacts (one open, one password). Pill reads `2 published`. Count is `2`, not `1` — open + password both count. Hint disappears, grid shows the two artefacts (flat, not bucketed by source folder).
4. Click `all`. Grid restores to the full set; `published` deactivates.
5. Unpublish one of the two (right-click → Unpublish). Within an SSE round-trip the pill reads `1 published` without a manual refresh.
6. Click `published`, then unpublish the last one. Pill drops to `0 published`. The grid replaces with the how-to hint again (no auto-reset — the empty state is the recovery path).

## Implementation notes

- The pill loop hide-rule excepts `"published"`: `if (count === 0 && src !== "all" && src !== "published") return null;`. Origin pills still hide at 0; `published` and `all` always render.
- The pip JSX is a small conditional inside the existing `.map` — `{src === "published" && <span className="pip pip-published" />}` placed before the count.
- `setArtefactSource("all")` already runs on space change (the existing `useEffect` resetting filters on scope switch). No additional reset logic — the empty-state hint replaces the auto-reset that earlier drafts of this design proposed.
- Empty-state hint renders in `Home/index.tsx` between the pill row and the artefact grid, conditional on `artefactSource === "published" && filteredArtefactsTotal === 0`. Uses the existing `.home-empty` class for visual consistency with the sessions/memories empty states.
- `flatten={artefactSource === "published"}` is passed to `Desktop` so artefacts render as their own tiles in this view (status filters cut across folders; source-folder bucketing would hide the result).

## What this design rejects

- **Composable filter dimensions** — too much state for too little reward in v1; revisit if a third status filter lands.
- **Renaming `ArtefactSource` to `ArtefactFilter`** — touches more files than the change justifies. Accept the slight semantic drift on the internal type name.
- **Splitting open vs password into two pills** — duplicates the per-tile chip's signal.
- **Hiding the pill at 0 + auto-resetting the filter** — earlier draft. The always-visible pill plus how-to hint is more useful than a hidden-pill + radio-snap-back behaviour, especially for first-time users who haven't published anything yet.
