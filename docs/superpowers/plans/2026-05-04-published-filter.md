# Published filter pill on Home — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `N published` pill to the Artefacts header on Home that filters the grid to currently-live publications.

**Architecture:** Extend the existing `artefactSource` radio with a fifth value `"published"`. Define a single `isLivePublication` predicate in `Home/index.tsx` and use it for both the count memo and the filter memo. Add a `useEffect` that resets `artefactSource` to `"all"` when the published count drops to zero (prevents an orphaned active filter with no visible pill). Purple pip prefix on the pill marks it as a status, not an origin.

**Tech Stack:** React + TypeScript (web), no test runner — verification is `npm run build` (tsc + vite) and manual click-through.

**Spec:** `docs/superpowers/specs/2026-05-04-published-filter-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `web/src/components/Home/types.ts` | Owns the `ArtefactSource` union — extend with `"published"` |
| `web/src/components/Home/index.tsx` | All pill behaviour — predicate, ORDER, LABELS, count memo, filter memo, JSX, auto-reset effect |
| `web/src/components/Home/Home.css` | Owns the new `.pip-published` colour rule (alongside the existing `.pip-*` rules) |
| `CHANGELOG.md` | User-visible entry under `[Unreleased] → Added` |

No backend changes. No `shared/types.ts` changes — the wire format already carries `publication`.

---

## Pre-flight

- [ ] **Step 0a: Verify worktree is clean and on the feature branch**

```bash
cd ~/Dev/oyster-os.worktrees/374-published-filter
git status --short
git branch --show-current
```

Expected: empty working tree (no `??` lines), branch is `feat/published-filter`.

- [ ] **Step 0b: Verify the build is green before changes**

```bash
cd ~/Dev/oyster-os.worktrees/374-published-filter/web
npm run build
```

Expected: PASS — `tsc -b` reports no errors, `vite build` writes to `dist/`.

If the build fails before any changes, stop and investigate — every step below assumes a green baseline.

---

## Task 1: Make the published pill work end-to-end

This task delivers a working pill: it renders, shows the right count, and filters the grid. It does **not** yet handle the count→0 auto-reset edge case (Task 2).

**Files:**
- Modify: `web/src/components/Home/types.ts:7`
- Modify: `web/src/components/Home/index.tsx:51-57` (ORDER + LABELS)
- Modify: `web/src/components/Home/index.tsx:433-441` (count memo)
- Modify: `web/src/components/Home/index.tsx:459-470` (filter memo)
- Modify: `web/src/components/Home/index.tsx:932-944` (JSX pill loop)
- Modify: `web/src/components/Home/Home.css` (append rule)

The order below interleaves changes so the codebase compiles after the type extension. TypeScript will demand `published` keys on `ARTEFACT_SOURCE_LABELS` and on the `counts` literal as soon as the union grows.

- [ ] **Step 1: Extend the `ArtefactSource` union**

Open `web/src/components/Home/types.ts`. Replace line 7:

```ts
export type ArtefactSource = "all" | "manual" | "ai_generated" | "discovered";
```

with:

```ts
// "published" is a *status*, not an origin — but it joins the same radio group on Home so users
// only deal with one filter dimension. The pip in the JSX (and the auto-reset effect in
// Home/index.tsx) are the bits that acknowledge the semantic mismatch. Renaming the type to
// e.g. ArtefactFilter touches more files than the change justifies; revisit if more status
// filters land.
export type ArtefactSource = "all" | "manual" | "ai_generated" | "discovered" | "published";
```

- [ ] **Step 2: Run `npm run build` and observe the expected type errors**

```bash
cd ~/Dev/oyster-os.worktrees/374-published-filter/web
npm run build
```

Expected: FAIL — `tsc -b` reports errors in `Home/index.tsx`, specifically:
- on `ARTEFACT_SOURCE_LABELS` (Record missing key `published`)
- on the `counts` literal in `artefactSourceCounts` memo (Record missing key `published`)

This is the type system pointing at the next two edits. Continue.

- [ ] **Step 3: Add `published` to `ARTEFACT_SOURCE_ORDER` and `ARTEFACT_SOURCE_LABELS`**

In `web/src/components/Home/index.tsx`, replace lines 51-57:

```ts
const ARTEFACT_SOURCE_ORDER: ArtefactSource[] = ["all", "manual", "ai_generated", "discovered"];
const ARTEFACT_SOURCE_LABELS: Record<ArtefactSource, string> = {
  all: "all",
  manual: "mine",
  ai_generated: "from agents",
  discovered: "linked",
};
```

with:

```ts
const ARTEFACT_SOURCE_ORDER: ArtefactSource[] = ["all", "manual", "ai_generated", "discovered", "published"];
const ARTEFACT_SOURCE_LABELS: Record<ArtefactSource, string> = {
  all: "all",
  manual: "mine",
  ai_generated: "from agents",
  discovered: "linked",
  published: "published",
};
```

- [ ] **Step 4: Add the `isLivePublication` predicate**

In `web/src/components/Home/index.tsx`, find the imports block (top of file). The `Artifact` type isn't currently imported there — `desktopProps` carries it transitively. We need it explicitly for the predicate.

First, check what's already imported from `shared/types`:

```bash
grep -n "shared/types" /Users/Matthew.Slight/Dev/oyster-os.worktrees/374-published-filter/web/src/components/Home/index.tsx
```

Expected output includes:
```
5:import type { Space } from "../../../../shared/types";
```

Update line 5 to also import `Artifact`:

```ts
import type { Artifact, Space } from "../../../../shared/types";
```

Then add the predicate as a top-level const just below the `ARTEFACT_SOURCE_LABELS` block (so it sits with the other module-scope constants — line ~58, after the closing brace of `ARTEFACT_SOURCE_LABELS`):

```ts
// Mirrors PublishedChip's live-check. A publication exists once a share token
// has been minted; unpublishedAt becomes non-null when the publication is retired.
const isLivePublication = (a: Artifact): boolean =>
  a.publication != null && a.publication.unpublishedAt == null;
```

- [ ] **Step 5: Tally the published count in the `artefactSourceCounts` memo**

In `web/src/components/Home/index.tsx`, find `artefactSourceCounts` (~line 433). Replace:

```ts
  const artefactSourceCounts = useMemo(() => {
    const counts: Record<ArtefactSource, number> = { all: 0, manual: 0, ai_generated: 0, discovered: 0 };
    counts.all = effectiveDesktopProps.artifacts.length;
    for (const a of effectiveDesktopProps.artifacts) {
      const o = a.sourceOrigin ?? "manual";
      if (o === "manual" || o === "ai_generated" || o === "discovered") counts[o]++;
    }
    return counts;
  }, [effectiveDesktopProps.artifacts]);
```

with:

```ts
  const artefactSourceCounts = useMemo(() => {
    const counts: Record<ArtefactSource, number> = { all: 0, manual: 0, ai_generated: 0, discovered: 0, published: 0 };
    counts.all = effectiveDesktopProps.artifacts.length;
    for (const a of effectiveDesktopProps.artifacts) {
      const o = a.sourceOrigin ?? "manual";
      if (o === "manual" || o === "ai_generated" || o === "discovered") counts[o]++;
      if (isLivePublication(a)) counts.published++;
    }
    return counts;
  }, [effectiveDesktopProps.artifacts]);
```

Note: `published` counts every live publication regardless of origin. An AI-generated artefact that's published increments both `ai_generated` and `published`. That's correct — the totals are independent dimensions even though the pills act as one radio.

- [ ] **Step 6: Add the `published` branch to the `filteredArtefacts` memo**

In `web/src/components/Home/index.tsx`, find `filteredArtefacts` (~line 459). Replace:

```ts
  const filteredArtefacts = useMemo(() => {
    let list = effectiveDesktopProps.artifacts;
    if (selectedFolderId === VAULT) {
      list = list.filter((a) => !a.sourceId);
    } else if (selectedFolderId) {
      list = list.filter((a) => a.sourceId === selectedFolderId);
    }
    if (artefactSource !== "all") {
      list = list.filter((a) => (a.sourceOrigin ?? "manual") === artefactSource);
    }
    return list;
  }, [effectiveDesktopProps.artifacts, artefactSource, selectedFolderId]);
```

with:

```ts
  const filteredArtefacts = useMemo(() => {
    let list = effectiveDesktopProps.artifacts;
    if (selectedFolderId === VAULT) {
      list = list.filter((a) => !a.sourceId);
    } else if (selectedFolderId) {
      list = list.filter((a) => a.sourceId === selectedFolderId);
    }
    if (artefactSource === "published") {
      list = list.filter(isLivePublication);
    } else if (artefactSource !== "all") {
      list = list.filter((a) => (a.sourceOrigin ?? "manual") === artefactSource);
    }
    return list;
  }, [effectiveDesktopProps.artifacts, artefactSource, selectedFolderId]);
```

- [ ] **Step 7: Render the pip in the pill loop**

In `web/src/components/Home/index.tsx`, find the artefact pills loop (~lines 932-944):

```tsx
              {ARTEFACT_SOURCE_ORDER.map((src) => {
                const count = artefactSourceCounts[src];
                if (count === 0 && src !== "all") return null;
                return (
                  <button
                    key={src}
                    className={`stat-btn${artefactSource === src ? " active" : ""}`}
                    onClick={() => setArtefactSource(src)}
                  >
                    {count} {ARTEFACT_SOURCE_LABELS[src]}
                  </button>
                );
              })}
```

Replace with:

```tsx
              {ARTEFACT_SOURCE_ORDER.map((src) => {
                const count = artefactSourceCounts[src];
                if (count === 0 && src !== "all") return null;
                return (
                  <button
                    key={src}
                    className={`stat-btn${artefactSource === src ? " active" : ""}`}
                    onClick={() => setArtefactSource(src)}
                  >
                    {src === "published" && <span className="pip pip-published" />}
                    {count} {ARTEFACT_SOURCE_LABELS[src]}
                  </button>
                );
              })}
```

- [ ] **Step 8: Add the `.pip-published` CSS rule**

In `web/src/components/Home/Home.css`, find the existing pip rules. Search for the block around line 230:

```bash
grep -n "pip-green\|pip-amber\|pip-red\|pip-dim" /Users/Matthew.Slight/Dev/oyster-os.worktrees/374-published-filter/web/src/components/Home/Home.css
```

Append `.pip-published` to that block (matches `#a78bfa` from `PublishedChip.css`):

```css
.pip-published { background: #a78bfa; }
```

If you want exact placement: insert it directly after the last `.pip-*` rule in the existing pip block, so all pip colours sit together.

- [ ] **Step 9: Verify the build is green**

```bash
cd ~/Dev/oyster-os.worktrees/374-published-filter/web
npm run build
```

Expected: PASS — no TypeScript errors, vite bundles successfully.

- [ ] **Step 10: Run lint**

```bash
cd ~/Dev/oyster-os.worktrees/374-published-filter/web
npm run lint
```

Expected: PASS (or no new warnings introduced by this task — check the diff against the baseline if there are pre-existing warnings).

- [ ] **Step 11: Manual smoke check**

Start dev server:

```bash
cd ~/Dev/oyster-os.worktrees/374-published-filter
npm run dev
```

Open the surface in a browser. Confirm:
- The Artefacts header shows the pills row: `N all` / `N mine` / `N from agents` / `N linked`.
- If you have no live publications, the new published pill does **not** appear (count is 0, `count === 0 && src !== "all"` hides it).
- If you have at least one live publication (publish one via right-click → Publish, or `/p <artefact>` from the chat bar), the pill appears as `N published` with a small purple dot to the left.
- Clicking the pill makes it active (purple background) and narrows the grid to live publications only.
- Clicking `all` deactivates `published` and shows the full grid.

Stop the dev server (`Ctrl-C`) before committing.

- [ ] **Step 12: Commit**

```bash
cd ~/Dev/oyster-os.worktrees/374-published-filter
git add web/src/components/Home/types.ts web/src/components/Home/index.tsx web/src/components/Home/Home.css
git commit -m "$(cat <<'EOF'
feat(home): published filter pill in artefacts header (#374)

Adds a 'N published' pill alongside all / mine / from agents / linked,
with a small purple pip marking it as a status (not an origin). Counts
and filters via a single isLivePublication predicate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Auto-reset on count → 0

Without this, unpublishing the last live artefact while the `published` filter is active leaves the user staring at an empty grid with no active pill (the pill hides when count drops to 0). One small `useEffect` corrects the impossible visible state.

**Files:**
- Modify: `web/src/components/Home/index.tsx` (add `useEffect` near the other filter-resetting effects)

- [ ] **Step 1: Add the auto-reset effect**

In `web/src/components/Home/index.tsx`, find the existing scope-change reset effect (~line 216). It looks like:

```tsx
  useEffect(() => {
    setMemoriesLimit(MEMORIES_PREVIEW);
    setArtefactsLimit(ARTEFACTS_PREVIEW);
    setArtefactSource("all");
    if (pendingFolderSelection.current) {
      setSelectedFolderId(pendingFolderSelection.current);
      pendingFolderSelection.current = null;
    } else {
      setSelectedFolderId(null);
    }
    setSelectedOrphanCwd(null);
  }, [scopedSpace, showElsewhere, isHomeView]);
```

Directly **after** that effect's closing `}, [...]);` (so the new effect sits with related logic), add:

```tsx
  // If the user has the published filter active and the count drops to 0
  // (e.g. they just unpublished the last live artefact), the pill hides
  // — without this reset they'd be left on an empty grid with no active
  // pill, a visibly broken radio state. The coupling here is bounded:
  // it only fires for an otherwise-impossible visible state.
  useEffect(() => {
    if (artefactSource === "published" && artefactSourceCounts.published === 0) {
      setArtefactSource("all");
    }
  }, [artefactSource, artefactSourceCounts.published]);
```

- [ ] **Step 2: Verify the build is green**

```bash
cd ~/Dev/oyster-os.worktrees/374-published-filter/web
npm run build
```

Expected: PASS.

- [ ] **Step 3: Manual edge-case check**

Start dev server again:

```bash
cd ~/Dev/oyster-os.worktrees/374-published-filter
npm run dev
```

In the browser:
- Publish one artefact (only one). Pill reads `1 published`.
- Click `published`. Grid narrows to that artefact, pill goes active (purple).
- Unpublish that artefact (right-click → Unpublish, or via the chip's link copy → unpublish flow).
- Within the SSE round-trip the pill should disappear AND the grid should show the full artefact set (filter auto-reset to `all`). The `all` pill should now read as active.

If instead the grid goes empty and no pill is active: the effect didn't fire — re-check the dependency array `[artefactSource, artefactSourceCounts.published]`.

Stop the dev server.

- [ ] **Step 4: Commit**

```bash
cd ~/Dev/oyster-os.worktrees/374-published-filter
git add web/src/components/Home/index.tsx
git commit -m "$(cat <<'EOF'
feat(home): auto-reset published filter when count drops to zero (#374)

Unpublishing the last live artefact while the filter is active hides
the pill (count === 0). Without this effect the user is left on an
empty grid with no active pill — the radio appears broken. This
single useEffect resets artefactSource to 'all' for that one case.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: CHANGELOG entry + full acceptance walkthrough

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a CHANGELOG entry**

Open `CHANGELOG.md`. Under `## [Unreleased]` → `### Added`, append a new bullet (after the existing "Public viewer for shared artefacts" entry — keeps publish-related items grouped):

```md
- **Filter Home to your published artefacts.** A new `published` pill in the Artefacts header narrows the grid to currently-live shares; the pill auto-tidies when you unpublish your last one. ([#374](https://github.com/mattslight/oyster/issues/374))
```

User-outcome lead-in, no internal file paths or implementation detail (per `CLAUDE.md` changelog conventions).

- [ ] **Step 2: Refresh `docs/changelog.html`**

```bash
cd ~/Dev/oyster-os.worktrees/374-published-filter
npm run build:changelog
```

Expected: regenerates `docs/changelog.html` from `CHANGELOG.md` without errors.

- [ ] **Step 3: Run the full acceptance walkthrough**

Start dev server:

```bash
cd ~/Dev/oyster-os.worktrees/374-published-filter
npm run dev
```

Walk through each acceptance step from the spec. Use a fresh browser tab so you start from a clean state:

1. **No publications:** open the surface. The Artefacts pill row shows `all` / `mine` / `from agents` / `linked` only. The `published` pill is **not visible** (count is 0). ✅
2. **Publish two artefacts (one open, one password):** publish each via right-click → Publish or `/p <artefact>`. The pill appears as `2 published` with a small purple dot. Count is 2 (both modes count). ✅
3. **Click `published`:** pill goes active (purple background); grid narrows to those two artefacts; whichever pill was active before deactivates. ✅
4. **Click `all`:** grid restores to the full set; `published` pill deactivates. ✅
5. **Unpublish one (still on `all`):** the pill updates to `1 published` within an SSE round-trip without a manual refresh. ✅
6. **Click `published`, then unpublish the last one:** within an SSE round-trip the pill **disappears**, the filter auto-resets to `all`, and the grid shows the full unfiltered set. The `all` pill is active. ✅

If any step fails, capture the failing step and the symptom, then return to the relevant Task to debug.

Stop the dev server.

- [ ] **Step 4: Commit the CHANGELOG**

```bash
cd ~/Dev/oyster-os.worktrees/374-published-filter
git add CHANGELOG.md docs/changelog.html
git commit -m "$(cat <<'EOF'
docs(changelog): published filter pill (#374)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Push and open a PR — ask user first**

This step touches shared state (remote + GitHub). Before running it, confirm with the user that they're ready to ship — they may want to inspect the branch locally first, run `oyster` against the build, or stage further edits.

When confirmed, push and open the PR:

```bash
cd ~/Dev/oyster-os.worktrees/374-published-filter
git push -u origin feat/published-filter
gh pr create --title "feat(home): published filter pill (#374)" --body "$(cat <<'EOF'
## Summary
- Adds a `N published` pill to the Artefacts header on Home, alongside `all` / `mine` / `from agents` / `linked`.
- Purple pip marks it as a status (not an origin); the pill participates in the existing radio.
- Single `isLivePublication` predicate drives both the count and the filter.
- Auto-resets to `all` when the count drops to zero (prevents an empty-grid-with-no-active-pill state).

## Spec
`docs/superpowers/specs/2026-05-04-published-filter-design.md`

## Test plan
- [ ] Pill hidden when no live publications exist
- [ ] Pill appears as `N published` with purple dot when ≥1 publication is live
- [ ] Open + password publications both count
- [ ] Clicking pill narrows grid to live publications only
- [ ] Clicking `all` (or any other pill) deactivates `published`
- [ ] SSE-driven count update on publish / unpublish (no manual refresh)
- [ ] Auto-reset to `all` when last publication is retired with filter active

Closes #374

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

Spec coverage check:

- ✅ Pill copy `published`, neutral pill with purple pip → Task 1 Steps 7+8
- ✅ Inactive treatment + active treatment (existing `.stat-btn.active`) → Task 1 Step 7 (uses existing stat-btn)
- ✅ Hide-when-zero (existing rule applies) → Task 1 Step 7 unchanged the existing guard
- ✅ Filter model: extend radio, mutually-exclusive → Task 1 Steps 1, 3, 6
- ✅ Single `isLivePublication` predicate → Task 1 Step 4
- ✅ Count uses predicate → Task 1 Step 5
- ✅ Filter uses predicate → Task 1 Step 6
- ✅ Live updates via existing SSE → no code change needed; verified in Task 1 Step 11 and Task 3 Step 3
- ✅ Auto-reset useEffect → Task 2
- ✅ CSS: `.pip-published { background: #a78bfa; }` → Task 1 Step 8
- ✅ CHANGELOG entry → Task 3 Step 1
- ✅ Manual acceptance — full spec walkthrough → Task 3 Step 3

Type consistency: `isLivePublication` signature is consistent across uses (Task 1 Steps 4, 5, 6). `ArtefactSource` literal `"published"` is consistent throughout. `artefactSourceCounts.published` access matches the Record key.

Placeholder scan: no TBDs, no "implement later", no missing code blocks. Every step shows the exact code or command to run.
