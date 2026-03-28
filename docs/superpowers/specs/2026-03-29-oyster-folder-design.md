# .oyster/ Folder Design

**Date:** 2026-03-29
**Status:** Approved

---

## Overview

`.oyster/` is a lightweight, repo-carried metadata folder that stores human intent — display name overrides, group assignments, kind overrides, and space config — keyed by `source_ref` so it survives rescans and machine migrations. The SQLite DB remains authoritative for all runtime, scan, and process state. `.oyster/` is a side-effect of user actions, not a competing store.

---

## Core principles

- **Discovery is deterministic.** The scanner decides what exists from the filesystem. `.oyster/` never encodes artifact existence.
- **DB is authoritative for runtime state.** Ports, process status, scan timestamps, icon generation state, and job state live in DB only.
- **`.oyster/` stores user intent only.** Only fields the user explicitly changed are written. Scanner-default values are never stored redundantly.
- **No auto-writes on scan.** `.oyster/` is only written when a user makes an explicit choice (rename, regroup, kind override, space colour change).

---

## File structure

```
<repo-root>/
  .oyster/
    space.json       ← space display name, colour
    overrides.json   ← user intent keyed by source_ref
    .gitignore       ← auto-generated; ignores icons/
    icons/           ← AI-generated icons (gitignored by default)
```

`repo_path` is machine-local and never written to `.oyster/`. It belongs in DB only.

---

## File schemas

### `space.json`

```json
{
  "version": 1,
  "name": "blunderfixer",
  "color": "#6057c4"
}
```

Fields: `version` (integer), `name` (string), `color` (hex string, optional).

### `overrides.json`

```json
{
  "version": 1,
  "overrides": {
    "web/:app":              { "label": "Blunderfixer Web", "group": "Apps" },
    "README.md:notes":       { "label": "README" },
    "docs/flow.mmd:diagram": { "group": "Docs" }
  }
}
```

Keys are `source_ref` strings (e.g. `web/:app`, `README.md:notes`, `docs/flow.mmd:diagram`). Values are objects containing only the fields that differ from scanner defaults. Missing fields mean "use the scanner default".

Allowed override fields per artifact:
- `label` — display name shown under the desktop icon
- `group` — visual group on the surface
- `kind` — see kind override restrictions below

### `.oyster/.gitignore`

Auto-generated on first write. Content:

```
icons/
```

This is `.oyster/.gitignore`, not the repo-root `.gitignore`. Users who want to gitignore the whole `.oyster/` folder add that to their repo-root `.gitignore` themselves.

---

## Kind override restrictions (v1)

Unrestricted kind overrides can produce nonsense (e.g. overriding an `app` to `notes`). In v1, only these transitions are permitted:

| From      | Allowed overrides to         |
|-----------|------------------------------|
| `notes`   | `diagram`                    |
| `diagram` | `notes`                      |
| `app`     | *(no kind override in v1)*   |

Any other kind override attempt is rejected with a clear error. This can be relaxed in a later version once the use cases are better understood.

---

## Read behaviour — merge on scan

The merge order is:

```
scanner defaults → .oyster/overrides.json → DB runtime state
```

**This applies to both new and existing artifacts.** On every scan (initial or rescan):

1. Scanner produces candidates with defaults (label from filename stem, kind from extension, group from `deriveGroup()`).
2. For each candidate, `source_ref` is used to look up any entry in `overrides.json`.
3. The merged result (scanner defaults + overrides) is applied to the DB row:
   - If the artifact row does not exist → insert with merged fields.
   - If the artifact row already exists and is active → update mutable fields (`label`, `group_name`, `artifact_kind`) with merged values.
4. DB runtime state (port, status, scan timestamps) is never touched by this merge.

This ensures that `.oyster/` changes pulled from git, or after a branch switch, are reflected on the next rescan — not just on first registration.

---

## Write behaviour

Writes are triggered only by explicit user actions:

| User action              | File written         | Fields changed              |
|--------------------------|----------------------|-----------------------------|
| Rename artifact          | `overrides.json`     | `label`                     |
| Change group             | `overrides.json`     | `group`                     |
| Override kind            | `overrides.json`     | `kind`                      |
| Change space colour      | `space.json`         | `color`                     |
| Change space name        | `space.json`         | `name`                      |

**Atomic writes.** Every write goes through: write to `<file>.tmp` → `fsync` → rename to target. This prevents corruption on interruption.

**Override cleanup.** Before writing, the new value is compared to the scanner default for that `source_ref`. If they match, the key is removed from `overrides.json` rather than stored. This keeps git diffs small and meaningful.

**First write.** If `.oyster/` does not exist, it is created along with a `.oyster/.gitignore` that ignores `icons/`.

---

## `OysterFileStore` — new class

A new `OysterFileStore` class handles all reads and writes to `.oyster/`. It is instantiated per space (keyed by `repo_path`). Neither `SpaceService` nor `ArtifactService` owns it — both call it via dependency injection.

```typescript
interface OysterFileStore {
  // Read
  readSpaceConfig(): { name?: string; color?: string } | null;
  readOverrides(): Record<string, ArtifactOverride>;  // keyed by source_ref

  // Write (atomic, cleanup-on-default)
  writeSpaceConfig(fields: Partial<{ name: string; color: string }>): void;
  writeOverride(sourceRef: string, fields: Partial<ArtifactOverride>, scannerDefaults: Partial<ArtifactOverride>): void;

  // Utilities
  readonly repoPath: string;
  readonly oysterDir: string;
  exists(): boolean;
}

interface ArtifactOverride {
  label?: string;
  group?: string | null;
  kind?: ArtifactKind;
}
```

---

## Phase 2 — Clone-to-userland

When `onboard_space` (MCP tool or wizard) receives a `repo_path` that contains `.oyster/space.json`:

1. Read `name` and `color` from `space.json` — skip the user input prompts.
2. Create the space row using the file-provided values.
3. Run the scanner as normal.
4. Merge `overrides.json` during scan (same merge path as Phase 1).

No extra user steps. Clone the repo, point Oyster at it, and the desktop surface matches what the original developer configured.

`repo_path` is still stored in DB only — it is never written to `.oyster/`.

---

## What stays out of `.oyster/`

| Field                        | Lives in  | Reason                                      |
|------------------------------|-----------|---------------------------------------------|
| `repo_path`                  | DB        | Machine-local                               |
| Port, process status         | DB        | Runtime, transient                          |
| Scan timestamps, scan status | DB        | Operational, not portable                  |
| Icon generation state        | DB        | Job state, transient                        |
| Generated icon files         | `.oyster/icons/` (gitignored) | Large binary, machine-specific |
| Artifact existence           | Filesystem + DB | Derived from scanning, not stored         |
| Source_ref (full artifact list) | DB   | Canonical — `.oyster/` only stores deltas  |
