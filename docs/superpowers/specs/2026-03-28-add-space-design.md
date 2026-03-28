# Add Space — Design Spec

**Date:** 2026-03-28
**Status:** Approved for Phase 1 implementation
**Scope:** Phase 1 (create space, local repo scan, deterministic discovery, register assets) + Phase 2 (AI generation) designed together; Phase 3–4 noted but not implemented yet

---

## Problem

Spaces are currently emergent — they exist only because artifacts reference a `space_id`. There is no way to create a space, attach a local repository to it, or auto-populate it with the assets already in that repo. Adding Blunderfixer (or any project) means manually creating each artifact one by one, via MCP or the chat bar.

---

## Goals

- First-class spaces: a space can be created, named, and attached to a local repo
- Deterministic discovery: a scan of the repo finds apps, docs, and diagrams without AI
- One-shot onboarding: discovered assets register as artifacts immediately
- Idempotent rescans: running again never duplicates artifacts
- Provenance: every artifact knows whether it was discovered, AI-generated, or manually created
- Two entry points, one backend: the desktop wizard and the MCP `onboard_space` tool call the same service
- AI is additive: optional generation of IA maps and user flows in a separate phase, not blocking

---

## Out of scope (future phases)

- **Phase 3:** Rescan diffing — detecting removed/changed files, stale artifact management
- **Phase 4:** Remote GitHub clone/import
- Space colour customisation UI (schema supports it; picker comes later)
- Per-artifact checkbox selection in the wizard (default: all discovered items registered; deselection is a Phase 1+ refinement)

---

## Database schema

### New `spaces` table

```sql
CREATE TABLE spaces (
  id                TEXT PRIMARY KEY,
  display_name      TEXT NOT NULL,
  repo_path         TEXT UNIQUE,
  color             TEXT,
  scan_status       TEXT NOT NULL DEFAULT 'none',
  scan_error        TEXT,
  last_scanned_at   TEXT,
  last_scan_summary TEXT,
  ai_job_status     TEXT,
  ai_job_error      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (scan_status IN ('none','scanning','complete','error')),
  CHECK (ai_job_status IS NULL OR ai_job_status IN ('pending','running','complete','error'))
);
```

**Notes:**
- `repo_path` is UNIQUE — one local repo maps to one space. Enforced after normalisation (see below).
- `color` is nullable. Auto-assigned from the existing `spaceColor` palette on create; user-overridable later.
- `last_scan_summary` stores JSON: `{ "discovered": 2, "skipped": 0, "resurfaced": 0, "errors": [] }`
- `CHECK` constraints are correct SQLite syntax at table creation. `source_origin` on artifacts is validated at the service layer (SQLite does not support `ALTER TABLE ADD CONSTRAINT CHECK` on existing tables).
- `updated_at` is a **service-layer responsibility** — updated explicitly on: create, scan status change, repo_path change, color change, AI job transition. No DB trigger.

### Additions to `artifacts` table

```sql
ALTER TABLE artifacts ADD COLUMN source_origin TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE artifacts ADD COLUMN source_ref TEXT;

CREATE UNIQUE INDEX artifacts_space_source_ref_uq
  ON artifacts(space_id, source_ref)
  WHERE source_ref IS NOT NULL;
```

**`source_origin`** values: `'manual'` | `'discovered'` | `'ai_generated'`
Validated at service layer, not by DB constraint.

**`source_ref`** format: `{relative-posix-path}:{artifact_kind}`
Examples:
- `web/:app`
- `admin/:app`
- `README.md:notes`
- `CHANGELOG.md:notes`
- `docs/architecture.md:notes`
- `docs/flow.mmd:diagram`

`source_ref` uses POSIX separators (`/`) regardless of OS. Normalised before storage.
Uniqueness is composite `(space_id, source_ref)` — the same relative path can exist in multiple spaces.

---

## `repo_path` normalisation

Before any insert or update involving `repo_path`:

```typescript
import { resolve } from "node:path";
const absolutePath = resolve(rawPath); // resolves relative paths and redundant separators
```

`path.resolve()` makes paths absolute and removes redundant separators. It does **not** expand `~` (handle that before calling resolve, e.g. replace leading `~/` with `os.homedir() + /`) and does **not** resolve symlinks. If true canonicalisation is required (symlink-safe uniqueness for the `repo_path UNIQUE` constraint), use `fs.realpath(absolutePath)` — but note this is async and requires the path to exist. Recommendation: use `path.resolve()` for normalisation on input, and let the `UNIQUE` constraint catch aliasing in practice. Document the limitation.

Platform-native separators are fine at this layer (the path is stored as-is for filesystem access); only `source_ref` values inside the scanner use POSIX normalisation.

---

## Scanner pipeline

### Entry point

```
POST /api/spaces/:id/scan
```

Calls `SpaceService.scanSpace(spaceId)`.

### Pre-scan validation

1. Space exists and has a `repo_path`
2. `repo_path` exists on disk and is a directory
3. `repo_path` is readable
4. No concurrent scan in progress for this space (in-memory per-space lock in `SpaceService`)

Fail fast on any violation — set `scan_status = 'error'`, `scan_error = <message>`, return 400/409.

### Walk rules

- Max depth: 4 levels
- Skip directories: `node_modules/`, `.git/`, `dist/`, `build/`, `.next/`, `out/`, `coverage/`, `.cache/`
- Skip file patterns: `*.lock`, `*.log`

### Detection rules (deterministic, no AI)

| Signal | Artifact kind | `source_ref` |
|---|---|---|
| Directory containing `package.json` with `scripts.dev` or `scripts.start`, AND (directory name is `web`, `admin`, `app`, `client`, `frontend` OR `dependencies` contains `react`/`vue`/`next`/`vite`/`svelte`) | `app` | `web/:app` |
| `README.md` at repo root | `notes` | `README.md:notes` |
| `CHANGELOG.md` at repo root | `notes` | `CHANGELOG.md:notes` |
| `*.md` files inside a `docs/` directory | `notes` | `docs/intro.md:notes` |
| `*.mmd` or `*.mermaid` files anywhere | `diagram` | `docs/flow.mmd:diagram` |

**Labels in Phase 1** are derived mechanically from the path: `web/` → "web", `admin/` → "admin", `README.md` → "README". AI enrichment of labels is Phase 2.

### Upsert logic (idempotency)

For each candidate:

```
look up (space_id, source_ref)
  not found         → INSERT, source_origin = 'discovered'
  found, active     → skip (already registered)
  found, soft-deleted (removed_at IS NOT NULL) → clear removed_at, update updated_at
```

Re-surfacing soft-deleted discovered artifacts is intentional product behaviour — a rescan acts as "re-surface", never as auto-delete. Files that disappear between scans are left alone; Phase 3 handles staleness.

### Scan result shape

```typescript
interface ScanResult {
  discovered: number;
  skipped: number;
  resurfaced: number;
  errors: string[];
  artifacts: Artifact[];
}
```

Returned by the endpoint and stored as `last_scan_summary` (counts only, not the full artifact list).

---

## Service layer

### `SpaceService`

```typescript
createSpace(params: { name: string; repoPath?: string }): Space
  // auto-assigns color from spaceColor palette
  // normalises repoPath before insert
  // creates spaces row; does NOT scan

scanSpace(spaceId: string): Promise<ScanResult>
  // acquires in-memory lock for spaceId
  // validates repo shape
  // runs detection walk
  // upserts artifacts
  // releases lock, updates scan_status + summary + updated_at

listSpaces(): Space[]
  // reads from spaces table — replaces current getDistinctSpaces() on ArtifactStore

getSpace(spaceId: string): Space | null
```

### In-memory scan lock

```typescript
private scanning = new Set<string>();

if (this.scanning.has(spaceId)) throw new Error("Scan already in progress");
this.scanning.add(spaceId);
try { /* scan */ } finally { this.scanning.delete(spaceId); }
```

---

## API surface (Phase 1)

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/spaces` | Create space (`{ name, repoPath? }`) |
| `GET` | `/api/spaces` | List spaces (replaces artifact-derived list) |
| `GET` | `/api/spaces/:id` | Get space with scan status |
| `POST` | `/api/spaces/:id/scan` | Trigger deterministic scan |

Existing `/api/artifacts` and MCP tools continue to work unchanged. The `list_spaces` MCP tool is updated to read from the spaces table.

---

## MCP tool: `onboard_space`

```typescript
onboard_space({
  name: string,          // display name → slugified to space id
  repo_path: string,     // absolute local path
  skip_ai?: boolean      // no-op in Phase 1 (AI generation not yet implemented); reserved for Phase 2
})

// returns:
{
  space_id: string,
  scan_summary: ScanResult,
  ai_job_id?: string     // present if AI generation triggered (Phase 2)
}
```

Calls `SpaceService.createSpace` + `SpaceService.scanSpace` directly — same code path as the desktop wizard. No separate implementation.

---

## UI: desktop wizard

**Entry point:** A "+" icon pill at the end of the space pill row in the ChatBar. Shows "Add Space" tooltip on hover. Tapping opens the wizard modal.

### Step 1 — Name & path

- Name input (free text; server slugifies to `space_id`)
- Folder picker showing selected directory name + abbreviated path + "ready to scan" hint once a valid directory is chosen
- Single CTA: **Scan**

### Step 2 — What was found (instant)

- Bold count: "5 things found"
- Quiet subtitle: "Uncheck anything you don't want on your desktop"
- Selectable list grouped by Apps / Docs — dot indicator per kind, name, kind badge
- Single CTA: **Add to desktop**
- (Checkbox deselection: Phase 1+ polish; all items register by default in Phase 1)

### Step 3 — AI (optional, Phase 2)

- Title: "Want AI to dig in?"
- Brief subtitle: "Oyster can generate a few reference docs from the repo. They'll appear as they complete."
- Toggle list: IA map, User flow diagram, Tech overview (last unchecked by default)
- Primary CTA: **Add space and generate**
- Secondary (ghost text): Skip — add space only

After confirmation: modal closes immediately. Space appears in the pill row. Discovered artifacts appear on the desktop. AI-generated artifacts appear as they complete (Phase 2).

---

## Phase roadmap

| Phase | Scope |
|---|---|
| **1** | Spaces table, artifact provenance fields, deterministic scanner, `SpaceService`, API endpoints, "+" UI entry, wizard steps 1–2, `onboard_space` MCP tool |
| **2** | `onboard_space` AI generation step, wizard step 3, background job runner, `ai_job_status` lifecycle |
| **3** | Rescan diffing — stale artifact detection, removed-file handling, re-scan UI trigger |
| **4** | Remote GitHub clone/import, `repo_path` from URL |
