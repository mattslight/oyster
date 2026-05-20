# New Session Affordance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `+ New session` pill right-aligned next to the running pill, plus a `⌘/` command-palette modal to start a fresh Claude session from anywhere in Oyster. Smart routing when inside a single-project space. Quiet "or pick a folder" escape hatch for un-attached folders.

> **Historical note:** Task 10 below was originally written for `⌘N`. During implementation we discovered Chrome reserves `⌘N` at the OS level (and `⌘E` collides with the Claude-in-Chrome extension) — the shipped shortcut is `⌘/`. The Task 10 code block is kept as the original plan for traceability; the actual implementation uses `⌘/` (see `web/src/App.tsx` and the spec at `docs/superpowers/specs/2026-05-19-new-session-design.md` §2).

**Architecture:** Reuses the existing terminal spawn path (`POST /api/terminals` with `source: { type: "project", id }`) untouched. Adds one flat-list server method + one route change. New React components (`NewSessionPicker`, `NewSessionPill`) mount from `App.tsx`. Recents persist in localStorage. Folder escape hatch reuses the existing `attachFolder()` → spawn pattern.

**Tech Stack:** TypeScript, React, vitest (server only), Node http, better-sqlite3, node-pty (existing — not touched).

**Spec:** `docs/superpowers/specs/2026-05-19-new-session-design.md` (read this first if any of the references below feel under-specified).

**Branch:** `new-session` (worktree at `~/Dev/oyster.worktrees/new-session`, based on `origin/main` post-terminal-minimise merge).

---

## File Structure

**Create:**
- `web/src/components/NewSessionPicker.tsx` — the modal: search input, grouped list, keyboard nav, folder escape hatch
- `web/src/components/NewSessionPicker.css` — styles (`.nsp-*`) colocated with the component
- `web/src/components/Topbar/NewSessionPill.tsx` — the `+ New session` pill
- `web/src/lib/new-session-recents.ts` — localStorage LRU module
- `web/src/data/all-projects.ts` — `fetchAllProjects()` + `useAllProjects()` hook (kept separate from `projects-api.ts` to leave that file scoped to per-space CRUD)

**Modify:**
- `server/src/project-service.ts` — add `listAll(): Project[]`
- `server/src/routes/projects.ts:42-53` — route handler calls `listAll()` when `space_id` is absent
- `server/test/project-service.test.ts` — add `describe("ProjectService.listAll")` block
- `web/src/App.tsx` — mount picker, install global shortcut handler (planned `⌘N`; shipped `⌘/` — see header note), pass `activeSpace` + handlers
- `web/src/components/Home/index.tsx:821-831` — render `NewSessionPill` next to running pill in the breadcrumb cluster

---

## Task 1: Server — `ProjectService.listAll()`

**Files:**
- Test: `server/test/project-service.test.ts` (extend, add new `describe` block)
- Modify: `server/src/project-service.ts` (add method after `listForSpace`, before `getById`)

- [ ] **Step 1: Write the failing test**

Append this block to `server/test/project-service.test.ts` right after the `describe("ProjectService.listForSpace", () => {…})` block (around line 144). Reuse the existing `beforeEach`/`afterEach` pattern.

```ts
describe("ProjectService.listAll", () => {
  let dir: string;
  let db: Database.Database;
  let service: ProjectService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oyster-ps-listall-"));
    db = initDb(dir);
    db.exec(`
      INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none');
      INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('home', 'Home', '#111', 'none');
    `);
    service = new ProjectService(db);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("returns active projects across all spaces, sorted by name", () => {
    service.createProject({ spaceId: "work", name: "Zebra" });
    service.createProject({ spaceId: "home", name: "Alpha" });
    service.createProject({ spaceId: "work", name: "Mango" });

    const projects = service.listAll();
    expect(projects.map((p) => p.name)).toEqual(["Alpha", "Mango", "Zebra"]);
    // Each row carries its space so the palette can show the breadcrumb.
    expect(projects.map((p) => p.spaceId).sort()).toEqual(["home", "work", "work"]);
  });

  it("excludes soft-deleted projects", () => {
    const keep = service.createProject({ spaceId: "work", name: "Keep" });
    const gone = service.createProject({ spaceId: "home", name: "Gone" });
    service.deleteProject(gone.id);

    const projects = service.listAll();
    expect(projects.map((p) => p.id)).toEqual([keep.id]);
  });

  it("exposes the same path-state fields as listForSpace (hasLivePath, recentPath, isGitRepo)", () => {
    const folder = mkdtempSync(join(tmpdir(), "oyster-listall-live-"));
    const proj = service.createProject({ spaceId: "work", name: "Live" });
    db.prepare("INSERT INTO project_paths (project_id, path) VALUES (?, ?)").run(proj.id, folder);

    const [listed] = service.listAll();
    expect(listed.hasLivePath).toBe(true);
    expect(listed.recentPath).toBe(folder);

    rmSync(folder, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Dev/oyster.worktrees/new-session/server && npx vitest run test/project-service.test.ts`
Expected: 3 new tests fail with TypeError or "listAll is not a function".

- [ ] **Step 3: Implement `listAll()`**

In `server/src/project-service.ts`, add this method between `listForSpace` and `getById` (around line 82):

```ts
  /** All non-removed projects across every space, sorted by name. Used by
   *  the New Session palette which presents one flat list. */
  listAll(): Project[] {
    const rows = this.db
      .prepare("SELECT id, space_id, name, created_at FROM projects WHERE removed_at IS NULL ORDER BY name COLLATE NOCASE")
      .all() as ProjectRow[];
    return rows.map((row) => ({ ...rowToProject(row), ...this.detectPathState(row.id) }));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Dev/oyster.worktrees/new-session/server && npx vitest run test/project-service.test.ts`
Expected: All `ProjectService.listAll` tests pass; existing `ProjectService.listForSpace` tests still pass.

- [ ] **Step 5: Commit**

```bash
cd ~/Dev/oyster.worktrees/new-session
git add server/src/project-service.ts server/test/project-service.test.ts
git commit -m "$(cat <<'EOF'
feat(projects): add ProjectService.listAll for cross-space listings

Mirrors listForSpace but drops the space filter. Used by the upcoming
New Session palette which presents one flat list with spaceId on each
row for the breadcrumb display.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Server — Relax `GET /api/projects` route

**Files:**
- Modify: `server/src/routes/projects.ts:42-53`
- Modify: `server/src/routes/projects.ts:5` (update endpoint comment)

- [ ] **Step 1: Update the route handler**

In `server/src/routes/projects.ts`, replace the `GET /api/projects` block (lines 42-53):

```ts
  if (pathname === "/api/projects" && req.method === "GET") {
    if (rejectIfNonLocalOrigin()) return true;
    try {
      const spaceId = query.get("space_id");
      sendJson(spaceId ? projectService.listForSpace(spaceId) : projectService.listAll());
    } catch (err) { sendError(err); }
    return true;
  }
```

Then update the comment block at the top of the file (line 5) to reflect the new behaviour:

```ts
//   GET  /api/projects                    list ALL active projects (flat)
//   GET  /api/projects?space_id=X         list active projects in space X
```

- [ ] **Step 2: Smoke-test by curl**

Start the dev server in a separate terminal:

```bash
cd ~/Dev/oyster.worktrees/new-session && npm run dev
```

Then in another shell:

```bash
curl -s http://localhost:3333/api/projects | head -c 200
```

Expected: a JSON array (possibly empty `[]` if the dev DB has no projects). No `space_id is required` error.

Also verify the per-space form still works:

```bash
curl -s 'http://localhost:3333/api/projects?space_id=home' | head -c 200
```

Expected: JSON array filtered to space `home`.

- [ ] **Step 3: Commit**

```bash
cd ~/Dev/oyster.worktrees/new-session
git add server/src/routes/projects.ts
git commit -m "$(cat <<'EOF'
feat(api): GET /api/projects without space_id returns all projects

Backwards-compatible: per-space form still works when space_id is
present. The flat form feeds the upcoming New Session palette.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Stop the dev server with Ctrl-C in its terminal.

---

## Task 3: Web — `fetchAllProjects()` + `useAllProjects()` hook

**Files:**
- Create: `web/src/data/all-projects.ts`

- [ ] **Step 1: Create the data module**

Create `web/src/data/all-projects.ts`:

```ts
// Cross-space project list. Mirrors useSpaceProjects but uses the flat
// /api/projects endpoint added for the New Session palette. Kept in a
// separate file so projects-api.ts stays scoped to per-space CRUD.

import { getJson } from "./http";
import { useFetched } from "../hooks/useFetched";
import type { Project } from "./projects-api";

export async function fetchAllProjects(signal?: AbortSignal): Promise<Project[]> {
  return getJson<Project[]>("/api/projects", signal);
}

export function useAllProjects(enabled: boolean): {
  projects: Project[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
} {
  const { data, loading, error, refresh } = useFetched<Project[]>(
    (signal) => fetchAllProjects(signal),
    [],
    { enabled },
  );
  return { projects: data, loading, error, refresh };
}
```

The `enabled` flag lets the palette only fetch when open — no point holding the list in memory the rest of the time.

- [ ] **Step 2: Type-check**

Run: `cd ~/Dev/oyster.worktrees/new-session/web && npx tsc --noEmit`
Expected: no new TypeScript errors.

- [ ] **Step 3: Commit**

```bash
cd ~/Dev/oyster.worktrees/new-session
git add web/src/data/all-projects.ts
git commit -m "$(cat <<'EOF'
feat(web): add fetchAllProjects + useAllProjects hook

Thin wrapper around the new flat /api/projects endpoint. Gated by an
`enabled` flag so the palette only fetches while open.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Web — `new-session-recents.ts` localStorage LRU

**Files:**
- Create: `web/src/lib/new-session-recents.ts`

- [ ] **Step 1: Create the module**

Create `web/src/lib/new-session-recents.ts`:

```ts
// Tiny LRU for "recently used" project ids in the New Session palette.
// Persisted to localStorage so recents survive reloads. Capped at 5; the
// list is the source of truth, no separate count maintained. localStorage
// can throw in privacy-mode browsers — every read/write is try/catch.

const KEY = "oyster-new-session-recents";
const MAX = 5;

export function getRecentProjectIds(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string").slice(0, MAX);
  } catch {
    return [];
  }
}

export function recordRecentProjectId(projectId: string): void {
  if (!projectId) return;
  try {
    const current = getRecentProjectIds().filter((id) => id !== projectId);
    const next = [projectId, ...current].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* privacy-mode browsers — recents simply don't persist */
  }
}
```

- [ ] **Step 2: Type-check**

Run: `cd ~/Dev/oyster.worktrees/new-session/web && npx tsc --noEmit`
Expected: no new TypeScript errors.

- [ ] **Step 3: Commit**

```bash
cd ~/Dev/oyster.worktrees/new-session
git add web/src/lib/new-session-recents.ts
git commit -m "$(cat <<'EOF'
feat(web): add new-session-recents LRU (localStorage)

Five most-recently-spawned project ids, in MRU order. Privacy-mode
safe (try/catch around every storage call).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Web — `NewSessionPicker.tsx` (render-only; no spawn yet)

Renders the palette UI. Spawn wiring lands in Task 6 so this task stays focused on the visual surface and keyboard interaction.

**Files:**
- Create: `web/src/components/NewSessionPicker.tsx`
- Create: `web/src/components/NewSessionPicker.css`

- [ ] **Step 1: Create the CSS**

Create `web/src/components/NewSessionPicker.css`. The colour palette mirrors the existing Oyster dark theme (see `web/src/App.css` for the canonical tokens — we don't redefine them here, just reference them):

```css
/* New Session palette — command-palette-style modal. Mounts at <body>
   via React portal-style absolute positioning; the overlay catches
   outside clicks. Keep z-index above terminal windows. */

.nsp-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  z-index: 10000;
  animation: nsp-fade 80ms ease-out;
}

@keyframes nsp-fade {
  from { opacity: 0; }
  to   { opacity: 1; }
}

.nsp-modal {
  width: 480px;
  max-width: calc(100vw - 32px);
  max-height: 70vh;
  background: var(--bg-panel, #14141c);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  color: var(--text-primary, #e8e8ee);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.nsp-search-row {
  position: relative;
  padding: 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.nsp-search-input {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  color: inherit;
  font-size: 14px;
  outline: none;
}

.nsp-search-input::placeholder {
  color: var(--text-dim, #777);
}

.nsp-search-kbd {
  position: absolute;
  right: 20px;
  top: 50%;
  transform: translateY(-50%);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--text-dim, #777);
  padding: 1px 5px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.3);
  pointer-events: none;
}

.nsp-list {
  overflow-y: auto;
  flex: 1;
  padding: 6px 0;
}

.nsp-group-label {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-dim, #888);
  padding: 8px 14px 4px;
}

.nsp-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  cursor: pointer;
  font-size: 13px;
}

.nsp-row:hover:not(.nsp-row--disabled) {
  background: rgba(255, 255, 255, 0.05);
}

.nsp-row--highlighted {
  background: rgba(124, 107, 255, 0.14);
}

.nsp-row--disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.nsp-row-name {
  font-weight: 500;
  color: var(--text-primary, #e8e8ee);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nsp-row-meta {
  color: var(--text-dim, #888);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
}

.nsp-empty {
  padding: 18px 14px;
  font-size: 13px;
  color: var(--text-dim, #888);
  text-align: center;
}

.nsp-error {
  padding: 8px 14px;
  margin: 6px 10px;
  border-radius: 5px;
  background: rgba(220, 64, 64, 0.12);
  color: #ff8888;
  font-size: 12px;
  border: 1px solid rgba(220, 64, 64, 0.3);
}

.nsp-footer {
  display: flex;
  justify-content: space-between;
  padding: 8px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 11px;
  color: var(--text-dim, #888);
}

.nsp-footer .nsp-kbd {
  padding: 1px 5px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.3);
  font-family: ui-monospace, monospace;
  margin-right: 4px;
}
```

- [ ] **Step 2: Create the component (render-only)**

Create `web/src/components/NewSessionPicker.tsx`:

```tsx
// Centered command-palette modal for starting a fresh Claude session.
// Renders search + grouped list (recents, then all). Keyboard nav +
// disabled rows. Spawn wiring is added in a follow-up task — for now
// `onActivate` is the seam.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../data/projects-api";
import type { Space } from "../../../shared/types";
import { getRecentProjectIds } from "../lib/new-session-recents";
import "./NewSessionPicker.css";

export interface NewSessionPickerProps {
  /** True when the modal should be mounted. Parent controls open/close. */
  open: boolean;
  /** Fired when the user presses Esc or clicks the overlay. */
  onClose: () => void;
  /** Pre-fill text for the search input (e.g. active space name when
   *  invoked from inside a multi-project space). */
  initialQuery?: string;
  /** Projects across all spaces. Loaded by the parent via `useAllProjects`. */
  projects: Project[];
  /** Spaces for breadcrumb display + folder-attach dropdown. */
  spaces: Space[];
  /** Fired when a non-disabled row is activated (click or ↵). */
  onActivate: (project: Project) => void;
}

interface Row {
  project: Project;
  spaceName: string;
  group: "recent" | "all";
  disabled: boolean;
}

export function NewSessionPicker({
  open, onClose, initialQuery, projects, spaces, onActivate,
}: NewSessionPickerProps) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state every open. We deliberately don't preserve search across
  // open/close — each invocation is a fresh task.
  useEffect(() => {
    if (open) {
      setQuery(initialQuery ?? "");
      setHighlightIdx(0);
      // Focus on next tick so the modal mounts before the focus call.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, initialQuery]);

  // Esc closes; ↑↓ moves highlight; ↵ activates. Mounted only while open.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => Math.min(i + 1, rows.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const row = rows[highlightIdx];
        if (row && !row.disabled) onActivate(row.project);
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // `rows` and `highlightIdx` are intentionally closed-over via the
    // event handler; we don't want stale-closure bugs but recomputing
    // listeners on every keystroke is wasteful. Use refs if needed —
    // for v1, lean on React's render cadence (it's a tiny modal).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  const spaceNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of spaces) map.set(s.id, s.displayName ?? s.id);
    return map;
  }, [spaces]);

  const recentIds = useMemo(() => getRecentProjectIds(), [open]);

  const rows: Row[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (p: Project) => {
      if (!q) return true;
      const name = p.name.toLowerCase();
      const path = (p.recentPath ?? "").toLowerCase();
      const space = (spaceNameById.get(p.spaceId) ?? "").toLowerCase();
      return name.includes(q) || path.includes(q) || space.includes(q);
    };

    const filtered = projects.filter(matches);
    const recentSet = new Set(recentIds);
    const recents = recentIds
      .map((id) => filtered.find((p) => p.id === id))
      .filter((p): p is Project => !!p);
    const others = filtered.filter((p) => !recentSet.has(p.id));

    const toRow = (p: Project, group: "recent" | "all"): Row => ({
      project: p,
      spaceName: spaceNameById.get(p.spaceId) ?? p.spaceId,
      group,
      disabled: p.hasLivePath === false,
    });

    return [
      ...recents.map((p) => toRow(p, "recent")),
      ...others.map((p) => toRow(p, "all")),
    ];
  }, [projects, query, recentIds, spaceNameById]);

  // Keep highlight in range when rows shrink (e.g. user types and the
  // list filters to fewer items).
  useEffect(() => {
    if (highlightIdx >= rows.length) setHighlightIdx(Math.max(0, rows.length - 1));
  }, [rows.length, highlightIdx]);

  if (!open) return null;

  return (
    <div
      className="nsp-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="nsp-modal" role="dialog" aria-label="Start new session">
        <div className="nsp-search-row">
          <input
            ref={inputRef}
            className="nsp-search-input"
            placeholder="Search projects…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="nsp-search-kbd">⌘N</span>
        </div>

        <div className="nsp-list">
          {rows.length === 0 ? (
            <div className="nsp-empty">No projects match.</div>
          ) : (
            <>
              {rows.some((r) => r.group === "recent") && (
                <div className="nsp-group-label">Recent</div>
              )}
              {rows.filter((r) => r.group === "recent").map((row, idx) => (
                <RowView key={row.project.id} row={row}
                  highlighted={idx === highlightIdx}
                  onClick={() => !row.disabled && onActivate(row.project)} />
              ))}
              {rows.some((r) => r.group === "all") && (
                <div className="nsp-group-label">All projects</div>
              )}
              {rows.filter((r) => r.group === "all").map((row, i) => {
                const idx = rows.filter((r) => r.group === "recent").length + i;
                return (
                  <RowView key={row.project.id} row={row}
                    highlighted={idx === highlightIdx}
                    onClick={() => !row.disabled && onActivate(row.project)} />
                );
              })}
            </>
          )}
        </div>

        <div className="nsp-footer">
          <span><span className="nsp-kbd">↑↓</span>nav <span className="nsp-kbd">↵</span>start</span>
          <span><span className="nsp-kbd">esc</span>close</span>
        </div>
      </div>
    </div>
  );
}

function RowView({ row, highlighted, onClick }: {
  row: Row;
  highlighted: boolean;
  onClick: () => void;
}) {
  const path = row.project.recentPath ?? "";
  const meta = row.disabled ? `${row.spaceName} · no folder` : `${row.spaceName} · ${path}`;
  return (
    <div
      className={[
        "nsp-row",
        highlighted && "nsp-row--highlighted",
        row.disabled && "nsp-row--disabled",
      ].filter(Boolean).join(" ")}
      onClick={onClick}
      title={row.disabled ? "This project has no folder on this machine." : undefined}
    >
      <span className="nsp-row-name">{row.project.name}</span>
      <span className="nsp-row-meta">{meta}</span>
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `cd ~/Dev/oyster.worktrees/new-session/web && npx tsc --noEmit`
Expected: no new TypeScript errors.

- [ ] **Step 4: Wire a temporary preview in `App.tsx` to inspect visually**

In `web/src/App.tsx`, near other component imports (around line 27), add:

```ts
import { NewSessionPicker } from "./components/NewSessionPicker";
import { useAllProjects } from "./data/all-projects";
```

Then inside the `App()` function body, after the existing `useSessions()` call (find it via `grep -n "useSessions" web/src/App.tsx`), add temporary debug state and a render block. **This is scaffolding — Task 6 will replace it with the real wire-up.** For now:

```tsx
  // TEMPORARY visual preview — replaced in Task 6 with real spawn wiring.
  const [pickerOpen, setPickerOpen] = useState(false);
  const { projects: allProjects } = useAllProjects(pickerOpen);
  useEffect(() => {
    // Press Shift+P to toggle the preview for now.
    const h = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === "P") {
        e.preventDefault();
        setPickerOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
```

And add the picker render somewhere safe — at the top level of the returned JSX, before `<Home …>`:

```tsx
      <NewSessionPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        projects={allProjects}
        spaces={spaces}
        onActivate={(p) => {
          // eslint-disable-next-line no-console
          console.log("[NewSessionPicker] would spawn", p.id);
          setPickerOpen(false);
        }}
      />
```

- [ ] **Step 5: Visually verify**

Run: `cd ~/Dev/oyster.worktrees/new-session && npm run dev`
Open `http://localhost:7337` (or `http://localhost:3333` if dev defaults have changed), press **Shift+P**, and confirm:
- The modal mounts centered with the search input focused.
- Typing filters the list (substring match on name + path + space).
- ↑↓ moves the highlight; ↵ logs `[NewSessionPicker] would spawn …` to the console.
- Disabled rows (any project where `hasLivePath === false`) have reduced opacity and can't be activated.
- Esc and overlay click both close the modal.

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
cd ~/Dev/oyster.worktrees/new-session
git add web/src/components/NewSessionPicker.tsx web/src/components/NewSessionPicker.css web/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(web): NewSessionPicker render-only (search + grouped list + nav)

Centered command-palette modal. Substring search across name + path +
space; recents pulled from localStorage; disabled rows for projects
without a live folder; full keyboard nav. Spawn wiring lands next.

Temporary Shift+P toggle in App.tsx for visual verification — will be
replaced by the real pill + ⌘N wiring in a later task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Web — Wire spawn from picker

Replace the temporary preview hook with the real spawn path. After this task, activating a project row actually starts a Claude terminal.

**Files:**
- Modify: `web/src/App.tsx` (replace the Shift+P scaffold with a real handler that calls the existing `handleLaunchClaudeFromProject`)

- [ ] **Step 1: Update the `onActivate` handler**

In `web/src/App.tsx`, locate the temporary `onActivate` block from Task 5 and replace it. The existing `handleLaunchClaudeFromProject` (around line 395) already calls `launchAndOpen` and surfaces errors. Reuse it. Also import the recents recorder:

At the imports section (~ line 26), alongside the existing `import { launchAndOpen, humanError } from "./lib/launch-terminal";`, add:

```ts
import { recordRecentProjectId } from "./lib/new-session-recents";
```

Add a new state for the in-modal error (errors stay in the picker rather than `alert`):

```tsx
  const [pickerError, setPickerError] = useState<string | null>(null);
```

Replace the `onActivate` block in the `<NewSessionPicker …>` JSX with:

```tsx
      <NewSessionPicker
        open={pickerOpen}
        onClose={() => { setPickerOpen(false); setPickerError(null); }}
        projects={allProjects}
        spaces={spaces}
        errorMessage={pickerError}
        onActivate={async (p) => {
          setPickerError(null);
          const outcome = await launchAndOpen(
            { kind: "claude_new", source: { type: "project", id: p.id } },
            dispatch,
          );
          if (outcome.ok) {
            recordRecentProjectId(p.id);
            setPickerOpen(false);
          } else {
            const hint = outcome.installHint ? ` (${outcome.installHint})` : "";
            setPickerError(`${humanError(outcome.error)}${hint}`);
          }
        }}
      />
```

- [ ] **Step 2: Extend `NewSessionPicker` to render `errorMessage`**

In `web/src/components/NewSessionPicker.tsx`, extend the props:

```ts
  /** Error to surface inline (e.g. binary_not_found). Cleared by the parent. */
  errorMessage?: string | null;
```

Add it to the function signature destructure (next to `onActivate`).

Then in the JSX, between `<div className="nsp-search-row">…</div>` and `<div className="nsp-list">…</div>`, add:

```tsx
        {errorMessage && <div className="nsp-error">{errorMessage}</div>}
```

- [ ] **Step 3: Type-check**

Run: `cd ~/Dev/oyster.worktrees/new-session/web && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Smoke-test**

Run: `cd ~/Dev/oyster.worktrees/new-session && npm run dev`

In the browser:
- Press **Shift+P** to open the palette.
- Pick a project with a live folder. Expected: a new Claude terminal window opens, palette closes, that project surfaces as **Recent** the next time you open the picker.
- Manually force a failure: rename a project's folder so it's homeless, restart dev, try to spawn into it (it'll be disabled — try a still-live one but kill the `claude` binary path temporarily to get `binary_not_found`, OR cap-terminals by opening many to get `too_many_terminals`). Verify the error renders in `.nsp-error` and the palette stays open.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
cd ~/Dev/oyster.worktrees/new-session
git add web/src/components/NewSessionPicker.tsx web/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(web): wire NewSessionPicker spawn → launchAndOpen + recents

Activating a project row now calls the existing launchAndOpen helper
(same path used by Launch Claude here). On success the project lands
at the top of the Recent group; on failure the human-readable error
renders in-modal and the palette stays open for retry.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Web — "Or pick a folder" escape hatch

Quiet secondary affordance below the project list. Reuses `attachFolder` to register the folder, then spawns through the normal path.

**Files:**
- Modify: `web/src/components/NewSessionPicker.tsx`
- Modify: `web/src/components/NewSessionPicker.css` (add `.nsp-folder-*` styles)

- [ ] **Step 1: Add CSS for the folder row**

Append to `web/src/components/NewSessionPicker.css`:

```css
.nsp-folder-wrap {
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  padding: 6px 14px 10px;
}

.nsp-folder-link {
  display: inline-block;
  padding: 4px 0;
  background: none;
  border: none;
  color: var(--text-dim, #888);
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: transparent;
}

.nsp-folder-link:hover {
  color: var(--text-primary, #e8e8ee);
  text-decoration-color: rgba(255, 255, 255, 0.3);
}

.nsp-folder-form {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.nsp-folder-input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 5px;
  color: inherit;
  font-size: 13px;
  font-family: ui-monospace, monospace;
  outline: none;
}

.nsp-folder-row {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  color: var(--text-dim, #888);
}

.nsp-folder-select {
  flex: 1;
  padding: 5px 6px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  color: inherit;
  font-size: 12px;
}

.nsp-folder-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.nsp-folder-btn {
  padding: 5px 12px;
  font-size: 12px;
  border-radius: 5px;
  cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
  color: inherit;
}

.nsp-folder-btn.nsp-folder-btn--primary {
  background: rgba(124, 107, 255, 0.25);
  border-color: rgba(124, 107, 255, 0.5);
  color: #d7cdff;
}

.nsp-folder-btn:disabled { opacity: 0.45; cursor: not-allowed; }
```

- [ ] **Step 2: Extend the picker with the folder hatch**

In `web/src/components/NewSessionPicker.tsx`:

Update imports at top:

```ts
import { attachFolder } from "../data/projects-api";
```

Filter meta-spaces (the dropdown must exclude `__all__` / `__archived__`). Add this constant near the top of the file:

```ts
// Meta-spaces aren't real homes for projects; the attach dropdown skips them.
const META_SPACE_IDS = new Set(["__all__", "__archived__"]);
```

Add new props for context — replace the `NewSessionPickerProps` block:

```ts
export interface NewSessionPickerProps {
  open: boolean;
  onClose: () => void;
  initialQuery?: string;
  projects: Project[];
  spaces: Space[];
  errorMessage?: string | null;
  onActivate: (project: Project) => void;
  /** Active space id when the palette was opened. Determines whether
   *  the folder form needs a space picker (only on Home / meta-spaces). */
  activeSpaceId: string;
  /** Same callback shape onActivate uses — invoked after attach. */
  onActivateAttached: (projectId: string) => void;
}
```

Inside the component body, add state + handler for the folder form:

```tsx
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  const [folderSpaceId, setFolderSpaceId] = useState<string>("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);

  const realSpaces = useMemo(
    () => spaces.filter((s) => !META_SPACE_IDS.has(s.id)),
    [spaces],
  );

  // Default the dropdown to the active space when it's a real space.
  useEffect(() => {
    if (META_SPACE_IDS.has(activeSpaceId) || activeSpaceId === "home") {
      setFolderSpaceId(realSpaces[0]?.id ?? "");
    } else {
      setFolderSpaceId(activeSpaceId);
    }
  }, [activeSpaceId, realSpaces, folderOpen]);

  // Reset folder UI on close.
  useEffect(() => {
    if (!open) {
      setFolderOpen(false);
      setFolderPath("");
      setFolderError(null);
    }
  }, [open]);

  const needsSpaceDropdown = META_SPACE_IDS.has(activeSpaceId) || activeSpaceId === "home";
  const canSubmitFolder =
    folderPath.trim().length > 0 &&
    !folderBusy &&
    (!!folderSpaceId);

  async function submitFolder() {
    const path = folderPath.trim();
    if (!path || !folderSpaceId) return;
    setFolderBusy(true);
    setFolderError(null);
    try {
      const { project } = await attachFolder(folderSpaceId, path);
      onActivateAttached(project.id);
    } catch (err) {
      setFolderError(err instanceof Error ? err.message : String(err));
    } finally {
      setFolderBusy(false);
    }
  }
```

In the JSX, after the `<div className="nsp-list">…</div>` block, before `<div className="nsp-footer">…</div>`, add the folder section:

```tsx
        <div className="nsp-folder-wrap">
          {!folderOpen ? (
            realSpaces.length > 0 && (
              <button
                type="button"
                className="nsp-folder-link"
                onClick={() => setFolderOpen(true)}
              >
                Or pick a folder…
              </button>
            )
          ) : (
            <div className="nsp-folder-form">
              <input
                className="nsp-folder-input"
                placeholder="/absolute/path or ~/relative"
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSubmitFolder) {
                    e.preventDefault();
                    void submitFolder();
                  }
                }}
              />
              {needsSpaceDropdown && (
                <div className="nsp-folder-row">
                  <span>Add to space:</span>
                  <select
                    className="nsp-folder-select"
                    value={folderSpaceId}
                    onChange={(e) => setFolderSpaceId(e.target.value)}
                  >
                    {realSpaces.map((s) => (
                      <option key={s.id} value={s.id}>{s.displayName ?? s.id}</option>
                    ))}
                  </select>
                </div>
              )}
              {folderError && <div className="nsp-error">{folderError}</div>}
              <div className="nsp-folder-actions">
                <button
                  type="button"
                  className="nsp-folder-btn"
                  onClick={() => setFolderOpen(false)}
                  disabled={folderBusy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="nsp-folder-btn nsp-folder-btn--primary"
                  onClick={submitFolder}
                  disabled={!canSubmitFolder}
                >
                  {folderBusy ? "Starting…" : "Start session"}
                </button>
              </div>
            </div>
          )}
        </div>
```

- [ ] **Step 3: Wire `onActivateAttached` in `App.tsx`**

In `web/src/App.tsx`, in the `<NewSessionPicker …>` JSX, pass the new props:

```tsx
        activeSpaceId={activeSpace}
        onActivateAttached={async (projectId) => {
          setPickerError(null);
          const outcome = await launchAndOpen(
            { kind: "claude_new", source: { type: "project", id: projectId } },
            dispatch,
          );
          if (outcome.ok) {
            recordRecentProjectId(projectId);
            setPickerOpen(false);
          } else {
            const hint = outcome.installHint ? ` (${outcome.installHint})` : "";
            setPickerError(`${humanError(outcome.error)}${hint}`);
          }
        }}
```

- [ ] **Step 4: Type-check**

Run: `cd ~/Dev/oyster.worktrees/new-session/web && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Smoke-test**

Run: `cd ~/Dev/oyster.worktrees/new-session && npm run dev`

- Press Shift+P on Home. Click **Or pick a folder…**. Verify the form appears with a space dropdown (because Home isn't a real space). Type a valid folder path (e.g. `~/Dev/oyster-dev`), select a space, click **Start session**. A Claude terminal should open.
- Navigate into a real space, press Shift+P, click the folder link. The space dropdown should be hidden (active space is implicit). Submit a path; verify the terminal opens and the project lands in that space's tile grid.
- Submit an invalid path (e.g. `/tmp/does-not-exist-zzz`). Verify the error renders in-modal and the palette stays open.

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
cd ~/Dev/oyster.worktrees/new-session
git add web/src/components/NewSessionPicker.tsx web/src/components/NewSessionPicker.css web/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(web): NewSessionPicker folder escape hatch

Quiet "Or pick a folder…" link below the list expands to an inline
path input. On Home (or any meta-space) the user also picks a target
space from a dropdown that filters out __all__ / __archived__. On
submit: attachFolder → launchAndOpen using the returned project id.
Errors render in-modal, palette stays open for retry.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Web — `NewSessionPill` + breadcrumb mount

Add the visible affordance and right-align the cluster alongside the running pill.

**Files:**
- Create: `web/src/components/Topbar/NewSessionPill.tsx`
- Modify: `web/src/components/Home/index.tsx:821-831` (breadcrumb mount)
- Modify: `web/src/App.css` (add `.nsp-pill` + adjust the breadcrumb cluster)

- [ ] **Step 1: Create the pill component**

Create `web/src/components/Topbar/NewSessionPill.tsx`:

```tsx
// "+ New session" pill. Sibling to RunningTerminalsPill in the breadcrumb
// nav. The cluster (running + new) is right-aligned; this pill is always
// visible while the running pill only renders when count > 0.

export function NewSessionPill({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="nsp-pill"
      onClick={onClick}
      title="Start a new Claude session (⌘N)"
    >
      <span aria-hidden="true">+</span>
      <span>New session</span>
    </button>
  );
}
```

- [ ] **Step 2: Add CSS**

Append to `web/src/App.css` (or wherever the existing `.rtp-pill` lives — grep for it to find the right neighbourhood):

```css
.nsp-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 11px;
  border-radius: 999px;
  background: rgba(124, 107, 255, 0.16);
  border: 1px solid rgba(124, 107, 255, 0.4);
  color: #c7bdff;
  font-size: 12px;
  cursor: pointer;
  transition: background 80ms;
}

.nsp-pill:hover {
  background: rgba(124, 107, 255, 0.26);
}

/* When both pills are present, the running pill sits to the LEFT of the
   new-session pill. Both cluster against the right edge of the breadcrumb. */
.home-breadcrumb-inner--right-cluster {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-left: auto;
}
```

- [ ] **Step 3: Mount the cluster in the breadcrumb**

In `web/src/components/Home/index.tsx`, locate the existing block (around line 821):

```tsx
            {onTerminalFocus && onTerminalRestore && onTerminalStop && presence.totalLive > 0 && (
              <div className="home-breadcrumb-inner home-breadcrumb-inner--running">
                <RunningTerminalsPill ... />
              </div>
            )}
```

Replace it with the cluster wrapper that always renders the new pill, and conditionally inserts the running pill:

```tsx
            <div className="home-breadcrumb-inner home-breadcrumb-inner--right-cluster">
              {onTerminalFocus && onTerminalRestore && onTerminalStop && presence.totalLive > 0 && (
                <RunningTerminalsPill
                  presence={presence}
                  sessions={sessions}
                  onFocus={onTerminalFocus}
                  onRestore={onTerminalRestore}
                  onStop={onTerminalStop}
                />
              )}
              {onOpenNewSession && <NewSessionPill onClick={onOpenNewSession} />}
            </div>
```

Add the import at the top of `Home/index.tsx`, alongside the existing `RunningTerminalsPill` import:

```ts
import { NewSessionPill } from "../Topbar/NewSessionPill";
```

Add `onOpenNewSession` to the `Home` component's props (the interface is `interface Props` at line 38, and the destructure list is the long single-line argument on line 152 — add `onOpenNewSession` next to `onTerminalFocus` in both places):

```ts
  /** Open the new-session palette. When omitted, the pill is hidden
   *  (e.g. in test contexts that don't wire it up). */
  onOpenNewSession?: () => void;
```

And in the function-parameter destructure, add it next to the other terminal callbacks.

- [ ] **Step 4: Replace the Shift+P scaffold with the pill in `App.tsx`**

In `web/src/App.tsx`:

Remove the temporary `Shift+P` keydown listener added in Task 5 (`useEffect` with `e.shiftKey && e.key === "P"`).

Pass `onOpenNewSession` to `<Home>`:

```tsx
        onOpenNewSession={() => setPickerOpen(true)}
```

Find the `<Home …>` JSX (around line 492) and add the prop there next to the other terminal callbacks (`onTerminalFocus` etc).

- [ ] **Step 5: Type-check + smoke-test**

```bash
cd ~/Dev/oyster.worktrees/new-session/web && npx tsc --noEmit
```

Expected: no new errors.

Then run dev and visually verify:

```bash
cd ~/Dev/oyster.worktrees/new-session && npm run dev
```

- The `+ New session` pill appears at the right edge of the breadcrumb.
- When a terminal is running, the running pill renders to its LEFT in the cluster.
- Clicking the pill opens the palette.
- Pill is visible on Home and inside every space view.

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
cd ~/Dev/oyster.worktrees/new-session
git add web/src/components/Topbar/NewSessionPill.tsx web/src/components/Home/index.tsx web/src/App.tsx web/src/App.css
git commit -m "$(cat <<'EOF'
feat(web): NewSessionPill in breadcrumb (right cluster with Running)

Always-visible "+ New session" pill at the right edge of the breadcrumb
nav. Sits next to the existing RunningTerminalsPill (when present); the
two share a right-aligned cluster div. Clicking the pill opens the
palette. Removes the temporary Shift+P scaffold added during render-only
development.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Web — Smart routing on pill click

When invoked from inside a single-project space, skip the palette and spawn directly. Inside a multi-project space, pre-fill the search with the space name.

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Add the routing helper**

The active space's project count + the active space's display name come from data already on hand: `useAllProjects` for projects (filtered by `spaceId`), `spaces` for the name. Define the routing logic next to where `setPickerOpen` lives.

Replace the existing `onOpenNewSession={() => setPickerOpen(true)}` callback with a smart-routing variant. First, hoist a stable callback:

```tsx
  // We can't useAllProjects(true) unconditionally — it would always fetch.
  // Keep the palette-driven fetch (gated by pickerOpen) AND add a separate
  // lightweight fetch for the smart-routing decision. Since pill clicks
  // are infrequent, fetch on demand in the handler.
  const [initialPickerQuery, setInitialPickerQuery] = useState<string | undefined>(undefined);

  const handleOpenNewSession = useCallback(async () => {
    if (activeSpace === "home" || activeSpace === "__all__" || activeSpace === "__archived__") {
      setInitialPickerQuery(undefined);
      setPickerOpen(true);
      return;
    }
    // Inside a real space: count live-folder projects to decide.
    try {
      const all = await fetchAllProjects();
      const inSpace = all.filter((p) => p.spaceId === activeSpace && p.hasLivePath !== false);
      if (inSpace.length === 1) {
        // Spawn silently — no palette.
        setPickerError(null);
        const outcome = await launchAndOpen(
          { kind: "claude_new", source: { type: "project", id: inSpace[0].id } },
          dispatch,
        );
        if (outcome.ok) {
          recordRecentProjectId(inSpace[0].id);
          return;
        }
        // Silent spawn failed — fall back to the palette with the error.
        const hint = outcome.installHint ? ` (${outcome.installHint})` : "";
        setPickerError(`${humanError(outcome.error)}${hint}`);
      }
      // 0 or 2+ → open palette. Pre-fill with the space name when 2+.
      const space = spaces.find((s) => s.id === activeSpace);
      setInitialPickerQuery(inSpace.length >= 2 ? (space?.displayName ?? "") : undefined);
      setPickerOpen(true);
    } catch (err) {
      // Network failure — open the palette with the error so the user
      // can retry / pick manually.
      setPickerError(err instanceof Error ? err.message : String(err));
      setPickerOpen(true);
    }
  }, [activeSpace, spaces, dispatch]);
```

Update the imports near the top of `App.tsx` to include `fetchAllProjects`:

```ts
import { useAllProjects, fetchAllProjects } from "./data/all-projects";
```

(`fetchAllProjects` exists from Task 3 — verify the import line picks it up.)

- [ ] **Step 2: Pass `initialQuery` to the picker**

In the `<NewSessionPicker …>` JSX, add the new prop:

```tsx
        initialQuery={initialPickerQuery}
```

Also clear it on close so the next open doesn't re-pre-fill:

```tsx
        onClose={() => { setPickerOpen(false); setPickerError(null); setInitialPickerQuery(undefined); }}
```

And wire the pill click:

```tsx
        onOpenNewSession={handleOpenNewSession}
```

- [ ] **Step 3: Smoke-test the routing matrix**

Run: `cd ~/Dev/oyster.worktrees/new-session && npm run dev`

- **Home**: click pill → palette opens, no pre-fill.
- **Single-project space**: navigate there, click pill → terminal spawns directly, no palette.
- **Multi-project space**: navigate there, click pill → palette opens with the space name pre-filled in the search.
- **Zero-project space**: navigate there (rare), click pill → palette opens without pre-fill (the user can attach a folder).

Stop the dev server.

- [ ] **Step 4: Commit**

```bash
cd ~/Dev/oyster.worktrees/new-session
git add web/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(web): smart routing on +New session pill click

Home / meta-spaces → open palette plain. Inside a real space, count
live-folder projects: 1 → spawn silently, 2+ → open palette pre-filled
with the space name, 0 → open palette plain so the user can attach a
folder or pick from elsewhere.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Web — `⌘N` global handler

Unconditional intercept — fires the same `handleOpenNewSession` no matter what's focused.

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Install the global keydown listener**

In `web/src/App.tsx`, near the other top-level `useEffect`s, add:

```tsx
  // ⌘N (or Ctrl+N off-Mac) opens the New Session palette. Unconditional —
  // intercepts even inside text inputs, textareas, contenteditable, and
  // the xterm.js helper textarea. Per spec §2: consistency over preserving
  // the browser's "new window" default.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      // Don't fire on ⌘⇧N (private window) or ⌘⌥N — keep the shortcut to
      // the bare combo. Modifier shape: only Cmd/Ctrl + N, no shift/alt.
      if (cmd && !e.shiftKey && !e.altKey && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        void handleOpenNewSession();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleOpenNewSession]);
```

- [ ] **Step 2: Smoke-test**

Run: `cd ~/Dev/oyster.worktrees/new-session && npm run dev`

- Press ⌘N on Home → palette opens.
- Click the chat input, press ⌘N → palette opens, no new browser window.
- Open a Claude terminal, click into it (focus the xterm.js textarea), press ⌘N → palette opens, the terminal doesn't receive an "N" keystroke.
- Press ⌘⇧N → private window opens (we don't intercept that).

Stop the dev server.

- [ ] **Step 3: Commit**

```bash
cd ~/Dev/oyster.worktrees/new-session
git add web/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(web): ⌘N opens New Session palette (unconditional intercept)

Per spec §2, the shortcut fires regardless of focus — including inside
input/textarea/contenteditable and the xterm.js helper textarea.
Consistency over preserving the browser's new-window default.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Web — Empty state + "+ Add space" CTA

Polish the empty state for fresh installs.

**Files:**
- Modify: `web/src/components/NewSessionPicker.tsx`

- [ ] **Step 1: Detect the empty install case and render the CTA**

In `web/src/components/NewSessionPicker.tsx`, replace the existing `rows.length === 0` branch in the `.nsp-list` block:

```tsx
          {rows.length === 0 ? (
            projects.length === 0 && realSpaces.length === 0 ? (
              <EmptyState onAddSpace={() => { onClose(); /* OnboardingDock handles the rest */ }} />
            ) : (
              <div className="nsp-empty">No projects match.</div>
            )
          ) : (
            // … existing groups …
          )}
```

Add the helper at the bottom of the file (after `RowView`):

```tsx
function EmptyState({ onAddSpace }: { onAddSpace: () => void }) {
  return (
    <div className="nsp-empty">
      <p style={{ marginBottom: 12 }}>Create or attach a project to start a session.</p>
      <button type="button" className="nsp-folder-btn nsp-folder-btn--primary" onClick={onAddSpace}>
        + Add space
      </button>
    </div>
  );
}
```

The CTA simply closes the palette. The `OnboardingDock` already mounted in `App.tsx` is the canonical add-space surface for fresh installs; this CTA is honest about handing off rather than re-implementing space creation inside the picker.

- [ ] **Step 2: Smoke-test**

The honest way to test this is on a userland with zero spaces. Use the existing onboarding-force URL parameter from `App.tsx:36`:

```bash
cd ~/Dev/oyster.worktrees/new-session && OYSTER_USERLAND=/tmp/oyster-empty-test npm run dev
```

(Or temporarily nuke `~/Oyster/db/oyster.db` after backing it up.)

Open `http://localhost:7337?onboarding=force` to reset the dock state. With zero spaces:
- Click the `+ New session` pill → palette opens.
- See the empty-state copy and `+ Add space` button.
- Click `+ Add space` → palette closes, OnboardingDock is the visible affordance for next steps.

Restore your real userland after the test.

- [ ] **Step 3: Commit**

```bash
cd ~/Dev/oyster.worktrees/new-session
git add web/src/components/NewSessionPicker.tsx
git commit -m "$(cat <<'EOF'
feat(web): NewSessionPicker empty-state copy + Add space CTA

Fresh install (no spaces, no projects): palette renders
"Create or attach a project to start a session." with an inline
+Add space button. The button closes the palette so the existing
OnboardingDock surface handles the actual space creation — no
hidden side-effects from inside the picker.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: CHANGELOG entry + final verification

**Files:**
- Modify: `CHANGELOG.md` (top of `Unreleased` / next version section)

- [ ] **Step 1: Inspect the existing CHANGELOG style**

Run: `head -40 ~/Dev/oyster.worktrees/new-session/CHANGELOG.md`

Note the section headers (Added / Changed / Fixed / Security) and the "bold lead-in" + 1-2 lines convention from `CLAUDE.md`.

- [ ] **Step 2: Add the entry**

In `CHANGELOG.md`, under the `Unreleased` section's **Added** subsection (create the subsection if it doesn't exist), insert:

```markdown
- **New session, from anywhere.** A `+ New session` pill in the topbar (or `⌘N`) opens a searchable palette covering every project across every space. Inside a single-project space, it just starts — no extra clicks.
```

- [ ] **Step 3: Regenerate the changelog HTML**

```bash
cd ~/Dev/oyster.worktrees/new-session && npm run build:changelog
```

Verify `docs/changelog.html` updated.

- [ ] **Step 4: Run the full server test suite**

```bash
cd ~/Dev/oyster.worktrees/new-session/server && npm test
```

Expected: all tests pass (including the new `ProjectService.listAll` cases).

- [ ] **Step 5: Final type-check**

```bash
cd ~/Dev/oyster.worktrees/new-session/web && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Manual acceptance walkthrough**

Run dev and walk the full acceptance-test list from the spec (§Acceptance tests, around line 220):

- Pill is visible everywhere the breadcrumb renders ✓
- Pill click on Home opens the palette (no pre-fill) ✓
- Pill click in a single-project space spawns silently ✓
- Pill click in a multi-project space opens the palette pre-scoped ✓
- ⌘N opens the palette unconditionally (test with focus in input, textarea, terminal) ✓
- Search filters substring on name, path, and space name ✓
- Disabled rows don't activate ✓
- Recents persist across reloads ✓
- Folder escape hatch attaches then spawns ✓
- Empty state on a fresh install shows the right copy + Add space CTA ✓
- Server-error rendering (e.g. `binary_not_found`) renders inline ✓

If any item fails, return to the relevant task to fix before committing.

- [ ] **Step 7: Commit**

```bash
cd ~/Dev/oyster.worktrees/new-session
git add CHANGELOG.md docs/changelog.html
git commit -m "$(cat <<'EOF'
chore(changelog): note new-session palette + ⌘N shortcut

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Done

All 12 tasks complete. Branch `new-session` is ready for PR review against `main`. Use the `superpowers:finishing-a-development-branch` skill to handle merge/PR creation.
