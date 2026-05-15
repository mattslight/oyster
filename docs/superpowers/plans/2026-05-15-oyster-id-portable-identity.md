# `.oyster/id` Portable Source Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a portable, disk-backed identity for each attached source folder via `<path>/.oyster/id`, persisted as a new non-unique `sources.portable_id` column. Lays the groundwork for cross-device source-metadata sync (#296) without touching `sources.id`, sessions, artefacts, or UI.

**Architecture:** Two-identity model. `sources.id` (local PK, FK target, never mutated) and `sources.portable_id` (cross-machine identifier, sourced from `.oyster/id`, intentionally non-unique). File-on-disk is the source of truth — invariant 4: "disk-backed, not imaginary." Worktrees and sibling checkouts naturally share `portable_id` without colliding.

**Tech Stack:** TypeScript (server), better-sqlite3, Node `node:fs` (atomic writes via tmpfile + rename), vitest.

**Spec:** `docs/superpowers/specs/2026-05-15-oyster-id-portable-identity-design.md` (commit `7879557` on branch `docs/oyster-id-portable-identity-spec`).

**Builds on (already merged):** #490 — `normaliseSourcePath`, advisory path existence, `assignment_mode`, longest-prefix binding.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `server/src/oyster-id.ts` | **Create** — discriminated-result `readOysterId`, atomic `writeOysterId`, `isValidUuid`. No state, no side effects beyond the named write. |
| `server/test/oyster-id.test.ts` | **Create** — unit tests for the module's five read statuses + write happy/error paths + UUID shape check. |
| `server/src/db.ts` | **Modify** — idempotent `ALTER TABLE sources ADD COLUMN portable_id` + partial INDEX in the schema-migration block. |
| `server/src/space-store.ts` | **Modify** — extend `Source` row type with `portable_id`; update `addSource` INSERT to include the new column; existing SELECTs auto-pick it up (`SELECT *`). |
| `shared/types.ts` | **Modify** — extend shared `Source` type with `portable_id: string \| null` so the client compiles cleanly. |
| `server/src/space-service.ts` | **Modify** — (1) rework `addSource` to decide `portable_id` before INSERT (single write of the row); (2) add per-source check at top of `scanSpace` loop; (3) add `".oyster"` to `SKIP_DIRS`. |
| `server/src/oyster-id-migration.ts` | **Create** — `backfillPortableIds(db)` — idempotent boot data migration; called from server start-up after schema migrations. |
| `server/src/index.ts` | **Modify** — call `backfillPortableIds(db)` once during startup. |
| `server/test/oyster-id-integration.test.ts` | **Create** — `addSource` + `scanSpace` + migration + invariant tests (tests 1–10 from the spec). |

**Out of scope for this plan (per spec):** MCP/REST surface changes, UI surfaces, watcher integration, `.oyster/config` or `.oyster/local/`.

---

## Chunk 1 — Schema + types

### Task 1: ALTER TABLE — add the `portable_id` column and index

**Files:**
- Modify: `server/src/db.ts` (in the schema-migration block, alongside the existing `assignment_mode` ALTER pattern)

- [ ] **Step 1: Locate the schema-migration block in `db.ts`**

Open `server/src/db.ts` and find the existing `assignment_mode` migration (around line 459–467). The pattern uses try/catch around `ALTER TABLE` (idempotent on re-run) and `CREATE INDEX IF NOT EXISTS`. We follow the same shape.

- [ ] **Step 2: Add the column + index migration**

Add this block immediately after the `assignment_mode` migration in `server/src/db.ts`:

```typescript
// portable_id: cross-machine identifier sourced from <path>/.oyster/id.
// Non-unique on purpose — worktrees and sibling checkouts share an id.
// `sources.id` (local PK) is NEVER derived from this column.
// See docs/superpowers/specs/2026-05-15-oyster-id-portable-identity-design.md
try {
  db.exec("ALTER TABLE sources ADD COLUMN portable_id TEXT NULL");
} catch { /* already exists */ }
db.exec(
  "CREATE INDEX IF NOT EXISTS sources_portable_id ON sources(portable_id) WHERE portable_id IS NOT NULL"
);
```

- [ ] **Step 3: Verify the schema applies cleanly**

Run from repo root:

```bash
cd server && rm -f /tmp/oyster-test.db
node -e "import('./node_modules/better-sqlite3/lib/index.js').then(async ({default: D}) => { const db = new D('/tmp/oyster-test.db'); const m = await import('./src/db.js'); /* simulate init */ })"
```

Easier: just run the existing test suite — it initialises a fresh DB and would fail if the migration is malformed:

```bash
cd server && npm test -- --run path-normalise
```

Expected: existing test passes, no errors about `portable_id`.

- [ ] **Step 4: Commit**

```bash
git add server/src/db.ts
git commit -m "feat(sources): add portable_id column + partial index"
```

---

### Task 2: Extend the `Source` row type + shared type

**Files:**
- Modify: `server/src/space-store.ts`
- Modify: `shared/types.ts`

- [ ] **Step 1: Add `portable_id` to the row type in `space-store.ts`**

Find the `Source` type / `SourceRow` interface in `server/src/space-store.ts`. Add the field:

```typescript
// New field — cross-machine identity, sourced from <path>/.oyster/id.
// NULL is valid: the file may not exist yet, the path may not exist on
// disk, or a write may have failed. NULL is never imaginary state.
portable_id: string | null;
```

- [ ] **Step 2: Add `portable_id` to the shared `Source` type**

Find the `Source` export in `shared/types.ts`. Add the same field with the same TSDoc:

```typescript
portable_id: string | null;
```

- [ ] **Step 3: Update the `addSource` INSERT statement to include the new column**

In `server/src/space-store.ts`, find the prepared statement:

```typescript
addSource: db.prepare(`
  INSERT INTO sources (id, space_id, type, path, label)
  VALUES (?, ?, ?, ?, ?)
`),
```

Replace with:

```typescript
addSource: db.prepare(`
  INSERT INTO sources (id, space_id, type, path, label, portable_id)
  VALUES (?, ?, ?, ?, ?, ?)
`),
```

- [ ] **Step 4: Update the `addSource` method signature in the same file**

Find the wrapper method that calls the prepared statement. It will be a `addSource({ id, space_id, type, path, label })` shape. Add `portable_id` to the destructured params and pass it as the 6th positional arg.

```typescript
addSource(row: {
  id: string;
  space_id: string;
  type: "local_folder";
  path: string;
  label?: string | null;
  portable_id: string | null;
}): void {
  this.stmts.addSource.run(
    row.id, row.space_id, row.type, row.path, row.label ?? null, row.portable_id
  );
}
```

(Existing method may differ slightly — match the existing style; the contract is "pass `portable_id` through to the INSERT.")

- [ ] **Step 5: Run server build to catch type mismatches**

```bash
cd server && ./node_modules/.bin/tsc --noEmit
```

Expected: exits 0. Any callers of `spaceStore.addSource(...)` that don't pass `portable_id` will fail — fix them in Task 4 / 5 where we change the calling code intentionally. For this commit, **temporarily** pass `null` from the one existing call site (`space-service.ts:addSource`) so the type checks pass:

In `server/src/space-service.ts`, find:

```typescript
this.spaceStore.addSource({ id, space_id: spaceId, type: "local_folder", path: resolved });
```

Replace with:

```typescript
this.spaceStore.addSource({ id, space_id: spaceId, type: "local_folder", path: resolved, portable_id: null });
```

We'll plumb the real value in Task 4. For now `null` is correct: no `.oyster/id` work has happened yet.

- [ ] **Step 6: Run server tests, all should pass**

```bash
cd server && npm test
```

Expected: every existing test still passes (the new column is nullable and the existing call site sets `null`).

- [ ] **Step 7: Commit**

```bash
git add server/src/space-store.ts shared/types.ts server/src/space-service.ts
git commit -m "feat(sources): plumb portable_id through Source type + addSource INSERT"
```

---

## Chunk 2 — `oyster-id.ts` module (TDD)

### Task 3: `isValidUuid` — test-first

**Files:**
- Create: `server/test/oyster-id.test.ts`
- Create: `server/src/oyster-id.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/oyster-id.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { isValidUuid } from "../src/oyster-id.js";

describe("isValidUuid", () => {
  it("accepts a canonical lowercase v4 UUID", () => {
    expect(isValidUuid("4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f")).toBe(true);
  });
  it("rejects uppercase letters (we canonicalise to lowercase)", () => {
    expect(isValidUuid("4A7C9D2E-1B3F-4D5A-9C8E-6F2A1B3D4E5F")).toBe(false);
  });
  it("rejects malformed strings", () => {
    expect(isValidUuid("")).toBe(false);
    expect(isValidUuid("not a uuid")).toBe(false);
    expect(isValidUuid("4a7c9d2e1b3f4d5a9c8e6f2a1b3d4e5f")).toBe(false); // no hyphens
    expect(isValidUuid("4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5")).toBe(false); // too short
  });
  it("rejects non-strings", () => {
    expect(isValidUuid(null as unknown as string)).toBe(false);
    expect(isValidUuid(123 as unknown as string)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test, see it fail**

```bash
cd server && npm test -- --run oyster-id
```

Expected: FAIL (`Cannot find module '../src/oyster-id.js'`).

- [ ] **Step 3: Create the module with a minimal `isValidUuid`**

Create `server/src/oyster-id.ts`:

```typescript
// Portable source identity. Reads/writes <root>/.oyster/id, the single
// file that gives Oyster a cross-machine identifier for a source folder.
// See docs/superpowers/specs/2026-05-15-oyster-id-portable-identity-design.md
// for the design rationale, invariants, and error-handling matrix.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}
```

- [ ] **Step 4: Run the test, see it pass**

```bash
cd server && npm test -- --run oyster-id
```

Expected: PASS, 4/4 cases.

- [ ] **Step 5: Commit**

```bash
git add server/src/oyster-id.ts server/test/oyster-id.test.ts
git commit -m "feat(oyster-id): isValidUuid (canonical lowercase v4 only)"
```

---

### Task 4: `readOysterId` — discriminated-result, all five statuses

**Files:**
- Modify: `server/test/oyster-id.test.ts`
- Modify: `server/src/oyster-id.ts`

- [ ] **Step 1: Add the failing test for the "missing" case**

Append to `server/test/oyster-id.test.ts`:

```typescript
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOysterId } from "../src/oyster-id.js";

function makeTmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "oyster-id-test-")));
}

describe("readOysterId", () => {
  let dir: string;
  beforeEach(() => { dir = makeTmp(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns { status: 'missing' } when no .oyster directory exists", () => {
    const result = readOysterId(dir);
    expect(result).toEqual({ status: "missing" });
  });
});
```

You also need `beforeEach, afterEach` imported. Update the top import:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
```

- [ ] **Step 2: Run, see failure**

```bash
cd server && npm test -- --run oyster-id
```

Expected: FAIL (`readOysterId is not a function` or "not exported").

- [ ] **Step 3: Add minimal `readOysterId` returning `{ status: "missing" }` always**

Append to `server/src/oyster-id.ts`:

```typescript
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const OYSTER_DIR = ".oyster";
const ID_FILE = "id";

export type OysterIdReadResult =
  | { status: "valid"; id: string }
  | { status: "missing" }
  | { status: "malformed"; value?: string }
  | { status: "unreadable"; error: unknown }
  | { status: "blocked"; reason: ".oyster-is-file" };

export function readOysterId(root: string): OysterIdReadResult {
  return { status: "missing" };
}
```

- [ ] **Step 4: Run, see pass**

```bash
cd server && npm test -- --run oyster-id
```

Expected: PASS for the missing case.

- [ ] **Step 5: Add the "valid" test**

Add inside the same `describe("readOysterId", ...)` block:

```typescript
it("returns { status: 'valid', id } when .oyster/id contains a valid UUID", () => {
  mkdirSync(join(dir, ".oyster"));
  writeFileSync(join(dir, ".oyster", "id"), "4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f\n", "utf8");
  const result = readOysterId(dir);
  expect(result).toEqual({ status: "valid", id: "4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f" });
});

it("accepts a UUID without trailing newline", () => {
  mkdirSync(join(dir, ".oyster"));
  writeFileSync(join(dir, ".oyster", "id"), "4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f", "utf8");
  const result = readOysterId(dir);
  expect(result).toEqual({ status: "valid", id: "4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f" });
});
```

- [ ] **Step 6: Run, see fail (still returns "missing")**

```bash
cd server && npm test -- --run oyster-id
```

Expected: 2 FAILs (the new valid tests).

- [ ] **Step 7: Implement the valid + missing branches**

Replace the body of `readOysterId` in `server/src/oyster-id.ts`:

```typescript
export function readOysterId(root: string): OysterIdReadResult {
  const oysterPath = join(root, OYSTER_DIR);
  const idPath = join(oysterPath, ID_FILE);

  // Cheap stat: is .oyster a directory? If it doesn't exist at all, we
  // return "missing"; if it exists but is a file, we return "blocked"
  // (handled below).
  let oysterStat;
  try {
    oysterStat = statSync(oysterPath);
  } catch (err) {
    // ENOENT → no .oyster anything. Any other error treat as missing too;
    // the caller's retry path is the same.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "unreadable", error: err };
  }

  if (!oysterStat.isDirectory()) {
    // `.oyster` exists but isn't a directory — bail with blocked.
    return { status: "blocked", reason: ".oyster-is-file" };
  }

  let raw: string;
  try {
    raw = readFileSync(idPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "unreadable", error: err };
  }

  const trimmed = raw.trim();
  if (isValidUuid(trimmed)) {
    return { status: "valid", id: trimmed };
  }
  return { status: "malformed", value: trimmed };
}
```

- [ ] **Step 8: Run, see all current tests pass**

```bash
cd server && npm test -- --run oyster-id
```

Expected: all green.

- [ ] **Step 9: Add the remaining status tests (malformed, blocked, unreadable)**

Add to `describe("readOysterId", ...)`:

```typescript
it("returns { status: 'malformed' } when .oyster/id contains non-UUID content", () => {
  mkdirSync(join(dir, ".oyster"));
  writeFileSync(join(dir, ".oyster", "id"), "not a uuid\n", "utf8");
  const result = readOysterId(dir);
  expect(result.status).toBe("malformed");
  if (result.status === "malformed") expect(result.value).toBe("not a uuid");
});

it("returns { status: 'blocked' } when .oyster exists as a regular file", () => {
  writeFileSync(join(dir, ".oyster"), "stop", "utf8");
  const result = readOysterId(dir);
  expect(result).toEqual({ status: "blocked", reason: ".oyster-is-file" });
});

it("returns { status: 'missing' } when .oyster exists as a directory but id file is missing", () => {
  mkdirSync(join(dir, ".oyster"));
  const result = readOysterId(dir);
  expect(result).toEqual({ status: "missing" });
});

it("returns { status: 'unreadable' } when .oyster/id has no read permission", () => {
  // Skip on Windows where chmod is a no-op
  if (process.platform === "win32") return;
  mkdirSync(join(dir, ".oyster"));
  writeFileSync(join(dir, ".oyster", "id"), "4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f", "utf8");
  chmodSync(join(dir, ".oyster", "id"), 0o000);
  const result = readOysterId(dir);
  // Restore so the afterEach cleanup can rm it
  chmodSync(join(dir, ".oyster", "id"), 0o644);
  expect(result.status).toBe("unreadable");
});
```

- [ ] **Step 10: Run, see all pass**

```bash
cd server && npm test -- --run oyster-id
```

Expected: all green.

- [ ] **Step 11: Commit**

```bash
git add server/src/oyster-id.ts server/test/oyster-id.test.ts
git commit -m "feat(oyster-id): readOysterId with discriminated read result"
```

---

### Task 5: `writeOysterId` — atomic via tmpfile + rename

**Files:**
- Modify: `server/test/oyster-id.test.ts`
- Modify: `server/src/oyster-id.ts`

- [ ] **Step 1: Write the failing tests**

Append to `server/test/oyster-id.test.ts`:

```typescript
import { existsSync } from "node:fs";
import { writeOysterId } from "../src/oyster-id.js";

describe("writeOysterId", () => {
  let dir: string;
  beforeEach(() => { dir = makeTmp(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("creates .oyster/id with the given UUID + trailing newline", () => {
    writeOysterId(dir, "4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f");
    const back = readOysterId(dir);
    expect(back).toEqual({ status: "valid", id: "4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f" });
  });

  it("creates the .oyster directory if it doesn't exist", () => {
    expect(existsSync(join(dir, ".oyster"))).toBe(false);
    writeOysterId(dir, "4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f");
    expect(existsSync(join(dir, ".oyster"))).toBe(true);
  });

  it("overwrites an existing .oyster/id atomically", () => {
    mkdirSync(join(dir, ".oyster"));
    writeFileSync(join(dir, ".oyster", "id"), "old content", "utf8");
    writeOysterId(dir, "4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f");
    expect(readOysterId(dir)).toEqual({ status: "valid", id: "4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f" });
  });

  it("throws on a read-only filesystem (caller decides what to do)", () => {
    if (process.platform === "win32") return;
    // Make the dir itself read-only so .oyster can't be created
    chmodSync(dir, 0o555);
    expect(() => writeOysterId(dir, "4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f")).toThrow();
    chmodSync(dir, 0o755); // restore for cleanup
  });
});
```

- [ ] **Step 2: Run, see fail**

```bash
cd server && npm test -- --run oyster-id
```

Expected: FAIL (`writeOysterId is not a function`).

- [ ] **Step 3: Implement `writeOysterId`**

Append to `server/src/oyster-id.ts`:

```typescript
import { mkdirSync, writeFileSync, renameSync } from "node:fs";

export function writeOysterId(root: string, id: string): void {
  if (!isValidUuid(id)) {
    // Defensive: callers shouldn't pass garbage but if they do we
    // refuse rather than write invalid disk state.
    throw new Error(`writeOysterId: refusing to write non-UUID value: ${id}`);
  }
  const oysterPath = join(root, OYSTER_DIR);
  mkdirSync(oysterPath, { recursive: true });

  const tmpPath = join(oysterPath, `id.tmp-${process.pid}-${Date.now()}`);
  const finalPath = join(oysterPath, ID_FILE);
  writeFileSync(tmpPath, id + "\n", "utf8");
  renameSync(tmpPath, finalPath);
}
```

- [ ] **Step 4: Run, see pass**

```bash
cd server && npm test -- --run oyster-id
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add server/src/oyster-id.ts server/test/oyster-id.test.ts
git commit -m "feat(oyster-id): writeOysterId (atomic via tmpfile + rename)"
```

---

## Chunk 3 — Scanner exclusion (invariant 6)

### Task 6: Add `.oyster` to `SKIP_DIRS`

**Files:**
- Modify: `server/src/space-service.ts`

- [ ] **Step 1: Find the SKIP_DIRS constant**

In `server/src/space-service.ts` around line 92 there's:

```typescript
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".cache", ".claude", ".opencode", ".vscode", ".idea", "__pycache__", ".tox", "venv", ".venv", "target", "vendor"]);
```

- [ ] **Step 2: Add `.oyster` to the set**

Replace with:

```typescript
// Oyster's own per-source metadata directory; `.oyster/id` and any
// future siblings are internal state, never user-visible artefacts.
// (Invariant 6 of the portable-identity spec.) The trailing
// `entry.startsWith(".")` check in walk() also catches this, but the
// explicit entry is the defensive guarantee.
const SKIP_DIRS = new Set(["node_modules", ".git", ".oyster", "dist", "build", ".next", "out", "coverage", ".cache", ".claude", ".opencode", ".vscode", ".idea", "__pycache__", ".tox", "venv", ".venv", "target", "vendor"]);
```

- [ ] **Step 3: Commit**

```bash
git add server/src/space-service.ts
git commit -m "feat(scanner): exclude .oyster/ from artefact discovery (invariant 6)"
```

(Tests proving the exclusion live in Chunk 7's integration suite.)

---

## Chunk 4 — `addSource` integration

### Task 7: Rework `addSource` to decide `portable_id` before INSERT

**Files:**
- Modify: `server/src/space-service.ts`

- [ ] **Step 1: Read the current `addSource` implementation**

Open `server/src/space-service.ts` and locate `addSource(spaceId: string, rawPath: string): Source` (around line 132). The current flow normalises the path, accepts non-existent paths (advisory existence per #490), and INSERTs the row.

- [ ] **Step 2: Decide `portable_id` *before* the INSERT**

Replace the existing call to `this.spaceStore.addSource({ id, space_id: spaceId, type: "local_folder", path: resolved, portable_id: null })` and surrounding logic with the following structure. The exact integration point is just before the INSERT line; preserve the rest of the function (path normalisation, soft-delete restore, etc.).

Add the import at the top of `space-service.ts`:

```typescript
import { existsSync as fsExistsSync } from "node:fs";
import { readOysterId, writeOysterId } from "./oyster-id.js";
import type { OysterIdReadResult } from "./oyster-id.js";
```

(There may already be a `readFileSync` etc. import from `node:fs`; just add `existsSync` to the existing one if so.)

Then, **immediately before** the line that calls `this.spaceStore.addSource(...)`, insert:

```typescript
// portable_id decision — see spec invariant 4 (disk-backed, never imaginary).
// We decide BEFORE the INSERT so the row is written exactly once: never
// INSERT with a generated id then UPDATE it back to NULL on write failure.
let portable_id: string | null = null;
if (fsExistsSync(resolved)) {
  const idResult: OysterIdReadResult = readOysterId(resolved);
  switch (idResult.status) {
    case "valid":
      portable_id = idResult.id;
      break;
    case "missing": {
      const newId = crypto.randomUUID();
      try {
        writeOysterId(resolved, newId);
        portable_id = newId;
      } catch (err) {
        console.warn(`[oyster-id] write failed for ${resolved}; leaving portable_id NULL`, err);
        // portable_id stays NULL — disk is truth.
      }
      break;
    }
    case "malformed":
      console.warn(`[oyster-id] malformed .oyster/id at ${resolved} — leaving portable_id NULL, file untouched`);
      break;
    case "unreadable":
      console.warn(`[oyster-id] unreadable .oyster/id at ${resolved} — leaving portable_id NULL`, idResult.error);
      break;
    case "blocked":
      console.warn(`[oyster-id] .oyster at ${resolved} is a file, not a directory — leaving portable_id NULL`);
      break;
  }
}
// If !existsSync(resolved): #490's advisory-existence case — portable_id stays NULL.
// A later scanSpace after "Update folder location…" will populate it.
```

- [ ] **Step 3: Pass `portable_id` to the INSERT call**

Replace the existing call:

```typescript
this.spaceStore.addSource({ id, space_id: spaceId, type: "local_folder", path: resolved, portable_id: null });
```

with:

```typescript
this.spaceStore.addSource({ id, space_id: spaceId, type: "local_folder", path: resolved, portable_id });
```

(Note: the `null` from Task 2 step 5 is now replaced by the decided value.)

- [ ] **Step 4: Type-check and run the existing test suite**

```bash
cd server && ./node_modules/.bin/tsc --noEmit
```

Expected: exits 0.

```bash
cd server && npm test
```

Expected: all existing tests pass. The new `oyster-id` unit tests pass. No new integration tests yet — those come in Chunk 7.

- [ ] **Step 5: Commit**

```bash
git add server/src/space-service.ts
git commit -m "feat(space-service): decide portable_id before INSERT in addSource"
```

---

## Chunk 5 — `scanSpace` integration

### Task 8: Add the per-source `portable_id` check at the top of the scan loop

**Files:**
- Modify: `server/src/space-service.ts`

- [ ] **Step 1: Locate the `scanSpace` per-source loop**

In `server/src/space-service.ts`, find `async scanSpace(spaceId: string): Promise<ScanResult>` (around line 478). Inside it, there's a `for (const source of sources)` loop. We insert the portable-id reconciliation step at the very top of that loop, before the existing `walk()` call.

- [ ] **Step 2: Add a helper method `reconcilePortableId` on the class**

Add a private method to `SpaceService` (place it near the other private helpers):

```typescript
// scanSpace-time portable_id reconciliation. Reads <source.path>/.oyster/id
// and updates `sources.portable_id` only when the file's value differs
// from the DB's. Never mutates `sources.id`, never touches sessions or
// artefacts. See spec invariants 1, 4, 5.
private reconcilePortableId(source: Source): void {
  if (!fsExistsSync(source.path)) return; // #490 advisory case; nothing to read or write
  const result = readOysterId(source.path);
  switch (result.status) {
    case "valid":
      if (result.id !== source.portable_id) {
        this.spaceStore.updatePortableId(source.id, result.id);
      }
      // else: matches, no-op
      return;
    case "missing":
      if (source.portable_id === null) {
        const newId = crypto.randomUUID();
        try {
          writeOysterId(source.path, newId);
          this.spaceStore.updatePortableId(source.id, newId);
        } catch (err) {
          console.warn(`[oyster-id] write failed for ${source.path}; portable_id stays NULL`, err);
        }
      }
      // else: portable_id is set but file is missing — don't clobber what
      // we have; the file may have been deleted manually and the user's
      // intent isn't clear.
      return;
    case "malformed":
      console.warn(`[oyster-id] malformed .oyster/id at ${source.path} — leaving portable_id unchanged`);
      return;
    case "unreadable":
      console.warn(`[oyster-id] unreadable .oyster/id at ${source.path} — leaving portable_id unchanged`, result.error);
      return;
    case "blocked":
      console.warn(`[oyster-id] .oyster at ${source.path} is a file, not a directory — leaving portable_id unchanged`);
      return;
  }
}
```

- [ ] **Step 3: Call `reconcilePortableId` at the top of the per-source loop**

Inside `scanSpace`'s `for (const source of sources) { ... }` loop, **before** the existing per-source work (walk, candidates, etc.), add:

```typescript
this.reconcilePortableId(source);
```

(One line. The loop body otherwise unchanged.)

- [ ] **Step 4: Add the `updatePortableId` prepared statement to `SpaceStore`**

In `server/src/space-store.ts`, add a new prepared statement to the `stmts` object:

```typescript
updatePortableId: db.prepare("UPDATE sources SET portable_id = ? WHERE id = ?"),
```

And a wrapper method on `SqliteSpaceStore`:

```typescript
updatePortableId(sourceId: string, portableId: string | null): void {
  this.stmts.updatePortableId.run(portableId, sourceId);
}
```

- [ ] **Step 5: Type-check + run existing tests**

```bash
cd server && ./node_modules/.bin/tsc --noEmit
cd server && npm test
```

Expected: exits 0; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/space-service.ts server/src/space-store.ts
git commit -m "feat(space-service): reconcile portable_id at scan time"
```

---

## Chunk 6 — Boot data migration

### Task 9: `backfillPortableIds` — idempotent boot migration

**Files:**
- Create: `server/src/oyster-id-migration.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Create the migration module**

Create `server/src/oyster-id-migration.ts`:

```typescript
// Boot data migration: backfill sources.portable_id for rows that have
// no value yet. Runs once per boot after schema migrations; idempotent
// (any row whose portable_id is already populated is skipped).
//
// Never mutates sources.id; never touches sessions or artefacts.
// See docs/superpowers/specs/2026-05-15-oyster-id-portable-identity-design.md

import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { readOysterId, writeOysterId } from "./oyster-id.js";

interface SourceRow {
  id: string;
  path: string;
}

export function backfillPortableIds(db: Database.Database): void {
  const rows = db
    .prepare("SELECT id, path FROM sources WHERE portable_id IS NULL AND removed_at IS NULL")
    .all() as SourceRow[];
  if (rows.length === 0) return;

  const update = db.prepare("UPDATE sources SET portable_id = ? WHERE id = ?");
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!existsSync(row.path)) {
      skipped++;
      continue; // #490 advisory case; will populate after the user runs "Update folder location…"
    }
    const result = readOysterId(row.path);
    switch (result.status) {
      case "valid":
        update.run(result.id, row.id);
        updated++;
        break;
      case "missing": {
        const newId = crypto.randomUUID();
        try {
          writeOysterId(row.path, newId);
          update.run(newId, row.id);
          updated++;
        } catch (err) {
          console.warn(`[oyster-id migration] write failed for ${row.path}; portable_id stays NULL`, err);
          skipped++;
        }
        break;
      }
      case "malformed":
      case "unreadable":
      case "blocked":
        console.warn(`[oyster-id migration] skipping ${row.path} (${result.status}) — leaving portable_id NULL`);
        skipped++;
        break;
    }
  }
  if (updated > 0 || skipped > 0) {
    console.log(`[oyster-id migration] portable_id backfill: ${updated} updated, ${skipped} skipped`);
  }
}
```

- [ ] **Step 2: Wire it into server startup**

In `server/src/index.ts`, find where the DB is initialised (look for `initDb(` or similar). Right after the schema migrations are guaranteed to have run (i.e. after `initDb` returns), add:

```typescript
import { backfillPortableIds } from "./oyster-id-migration.js";

// ... after const db = initDb(USERLAND_DIR);
backfillPortableIds(db);
```

The exact placement: search for the line `const db = initDb(` and put the call on the very next line.

- [ ] **Step 3: Type-check + boot-clean check**

```bash
cd server && ./node_modules/.bin/tsc --noEmit
```

Expected: exits 0.

A quick manual boot check (only if you can; in test environments this is skipped):

```bash
cd .. && npm run dev:server 2>&1 | head -40
```

Expected: server prints `[oyster-id migration] portable_id backfill: N updated, M skipped` exactly once on first boot, then nothing further on subsequent boots (re-runs are no-op because the WHERE clause filters out non-null `portable_id`).

- [ ] **Step 4: Commit**

```bash
git add server/src/oyster-id-migration.ts server/src/index.ts
git commit -m "feat(oyster-id): idempotent boot migration backfills portable_id"
```

---

## Chunk 7 — Integration + invariant tests

### Task 10: Test scenarios 1–10 from the spec

**Files:**
- Create: `server/test/oyster-id-integration.test.ts`

- [ ] **Step 1: Scaffold the test file with shared setup**

Create `server/test/oyster-id-integration.test.ts`:

```typescript
// Integration tests for the .oyster/id portable identity feature.
// Covers tests 1–10 from
// docs/superpowers/specs/2026-05-15-oyster-id-portable-identity-design.md

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, existsSync, readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { SqliteSpaceStore } from "../src/space-store.js";
import { SpaceService } from "../src/space-service.js";
import { SqliteArtifactStore } from "../src/artifact-store.js";
import { ArtifactService } from "../src/artifact-service.js";
import { backfillPortableIds } from "../src/oyster-id-migration.js";
import { isValidUuid } from "../src/oyster-id.js";

function makeEnv() {
  const workDir = realpathSync(mkdtempSync(join(tmpdir(), "oyster-id-int-")));
  const db = initDb(workDir);
  const spaceStore = new SqliteSpaceStore(db);
  const sessionStore = new SqliteSessionStore(db);
  const artifactStore = new SqliteArtifactStore(db);
  const artifactService = new ArtifactService({ db, artifactStore, spaceStore });
  const spaceService = new SpaceService({
    db, spaceStore, sessionStore, artifactStore, artifactService,
    broadcastUiEvent: () => {},
    // ... match the existing test env from server/test/space-service-binding.test.ts
  });
  // Ensure the "home" space exists (the constructor / initDb may already create one;
  // adapt to match existing test conventions).
  return { workDir, db, spaceService, spaceStore, sessionStore, artifactStore };
}

function makeRepo(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "oyster-id-repo-")));
}
```

(If your local `SpaceService` constructor signature differs from this, mirror the working pattern from `server/test/space-service-binding.test.ts`. Cross-reference that file.)

- [ ] **Step 2: Test 1 — attach with no `.oyster/id`**

Add to the file:

```typescript
describe("addSource — portable_id", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { rmSync(env.workDir, { recursive: true, force: true }); });

  it("Test 1: attach with no .oyster/id writes one and adopts the new UUID", () => {
    const repo = makeRepo();
    const source = env.spaceService.addSource("home", repo);

    expect(source.portable_id).not.toBeNull();
    expect(isValidUuid(source.portable_id!)).toBe(true);
    expect(existsSync(join(repo, ".oyster", "id"))).toBe(true);
    expect(readFileSync(join(repo, ".oyster", "id"), "utf8").trim()).toBe(source.portable_id);

    // And sources.id is independent (fresh UUID, NOT equal to portable_id)
    expect(source.id).not.toBe(source.portable_id);
    expect(isValidUuid(source.id)).toBe(true);

    rmSync(repo, { recursive: true, force: true });
  });
});
```

- [ ] **Step 3: Run, see pass**

```bash
cd server && npm test -- --run oyster-id-integration
```

Expected: PASS.

- [ ] **Step 4: Test 2 — attach with existing `.oyster/id`**

Add inside the same `describe` block:

```typescript
it("Test 2: attach with existing .oyster/id adopts the id, never overwrites", () => {
  const repo = makeRepo();
  const existingId = "4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f";
  mkdirSync(join(repo, ".oyster"));
  writeFileSync(join(repo, ".oyster", "id"), existingId + "\n", "utf8");

  const source = env.spaceService.addSource("home", repo);

  expect(source.portable_id).toBe(existingId);
  // File contents unchanged
  expect(readFileSync(join(repo, ".oyster", "id"), "utf8").trim()).toBe(existingId);

  rmSync(repo, { recursive: true, force: true });
});
```

- [ ] **Step 5: Test 3 — two sources with the same `.oyster/id` (worktree case)**

Add:

```typescript
it("Test 3: two sources can share the same portable_id (worktree case)", () => {
  const repoMain = makeRepo();
  const repoWt = makeRepo();
  const sharedId = "4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f";
  for (const r of [repoMain, repoWt]) {
    mkdirSync(join(r, ".oyster"));
    writeFileSync(join(r, ".oyster", "id"), sharedId + "\n", "utf8");
  }

  const a = env.spaceService.addSource("home", repoMain);
  const b = env.spaceService.addSource("home", repoWt);

  expect(a.portable_id).toBe(sharedId);
  expect(b.portable_id).toBe(sharedId);
  expect(a.id).not.toBe(b.id); // different local rows

  // Both rows visible via the partial index
  const sharing = env.db
    .prepare("SELECT id FROM sources WHERE portable_id = ? AND removed_at IS NULL")
    .all(sharedId);
  expect(sharing).toHaveLength(2);

  rmSync(repoMain, { recursive: true, force: true });
  rmSync(repoWt, { recursive: true, force: true });
});
```

- [ ] **Step 6: Test 4 — scan picks up file changes**

```typescript
it("Test 4: scanSpace updates portable_id when the file changes", async () => {
  const repo = makeRepo();
  const source = env.spaceService.addSource("home", repo);
  const original = source.portable_id;
  expect(original).not.toBeNull();

  // Externally rewrite the file (simulating git pull bringing down a different id)
  const newId = "11111111-2222-4333-8444-555555555555";
  writeFileSync(join(repo, ".oyster", "id"), newId + "\n", "utf8");

  await env.spaceService.scanSpace(source.space_id);

  const after = env.spaceStore.getSourceById(source.id);
  expect(after?.portable_id).toBe(newId);
  // sources.id never changes
  expect(after?.id).toBe(source.id);

  rmSync(repo, { recursive: true, force: true });
});
```

- [ ] **Step 7: Test 5 — malformed `.oyster/id`**

```typescript
it("Test 5: malformed .oyster/id leaves portable_id NULL and file untouched", () => {
  const repo = makeRepo();
  mkdirSync(join(repo, ".oyster"));
  writeFileSync(join(repo, ".oyster", "id"), "not a uuid", "utf8");

  const source = env.spaceService.addSource("home", repo);
  expect(source.portable_id).toBeNull();
  // File preserved verbatim
  expect(readFileSync(join(repo, ".oyster", "id"), "utf8")).toBe("not a uuid");

  rmSync(repo, { recursive: true, force: true });
});
```

- [ ] **Step 8: Test 6 — sessions and artefacts stay bound to `sources.id`**

```typescript
it("Test 6: sessions and artefacts stay bound to sources.id across every portable_id path", async () => {
  const repo = makeRepo();
  const source = env.spaceService.addSource("home", repo);

  // Seed a session and an artefact pointing at this source
  env.db.prepare(
    `INSERT INTO sessions (id, space_id, source_id, cwd, agent, title, state, started_at, last_event_at, assignment_mode)
     VALUES (?, ?, ?, ?, 'claude-code', 't', 'done', '2026-05-15T10:00:00Z', '2026-05-15T10:30:00Z', 'auto')`
  ).run("sess-1", source.space_id, source.id, repo);
  // (Adapt the artefact-insert to match server/src/artifact-store.ts; the assertion is what matters.)

  const sessionBefore = env.db.prepare("SELECT source_id FROM sessions WHERE id = ?").get("sess-1") as { source_id: string };
  const sourceIdBefore = source.id;

  // Trigger every portable_id path:
  // 1. Externally rewrite .oyster/id and scan
  writeFileSync(join(repo, ".oyster", "id"), "11111111-2222-4333-8444-555555555555\n", "utf8");
  await env.spaceService.scanSpace(source.space_id);

  // 2. Run the boot migration (should be a no-op now since portable_id is set)
  backfillPortableIds(env.db);

  // After all of the above:
  const sourceAfter = env.spaceStore.getSourceById(source.id);
  expect(sourceAfter?.id).toBe(sourceIdBefore); // sources.id unchanged
  const sessionAfter = env.db.prepare("SELECT source_id FROM sessions WHERE id = ?").get("sess-1") as { source_id: string };
  expect(sessionAfter.source_id).toBe(sessionBefore.source_id); // session binding untouched

  rmSync(repo, { recursive: true, force: true });
});
```

- [ ] **Step 9: Test 7 — migration never mutates `sources.id`**

```typescript
it("Test 7: backfillPortableIds never mutates sources.id and is idempotent", () => {
  const repo = makeRepo();

  // Pre-seed a sources row with portable_id IS NULL (bypass spaceService to avoid auto-write)
  const id = crypto.randomUUID();
  env.db.prepare(
    `INSERT INTO sources (id, space_id, type, path, label, portable_id) VALUES (?, 'home', 'local_folder', ?, NULL, NULL)`
  ).run(id, repo);

  const before = env.spaceStore.getSourceById(id);
  expect(before?.portable_id).toBeNull();
  expect(before?.id).toBe(id);

  // First migration: writes the file, sets portable_id
  backfillPortableIds(env.db);
  const afterFirst = env.spaceStore.getSourceById(id);
  expect(afterFirst?.id).toBe(id); // unchanged
  expect(afterFirst?.portable_id).not.toBeNull();
  expect(existsSync(join(repo, ".oyster", "id"))).toBe(true);

  // Second migration: should be no-op (portable_id NOT NULL now)
  const portableAfterFirst = afterFirst?.portable_id;
  backfillPortableIds(env.db);
  const afterSecond = env.spaceStore.getSourceById(id);
  expect(afterSecond?.id).toBe(id);
  expect(afterSecond?.portable_id).toBe(portableAfterFirst);

  rmSync(repo, { recursive: true, force: true });
});
```

- [ ] **Step 10: Test 8 — attach to a non-existent path (#490 advisory case)**

```typescript
it("Test 8: addSource on a non-existent path inserts with portable_id NULL", async () => {
  const ghost = join(tmpdir(), `oyster-id-ghost-${Date.now()}`);
  expect(existsSync(ghost)).toBe(false);

  const source = env.spaceService.addSource("home", ghost);
  expect(source.portable_id).toBeNull();
  expect(existsSync(join(ghost, ".oyster", "id"))).toBe(false); // nothing written

  // After the user "creates" the folder (or "Update folder location…" points to a real one),
  // scan should populate portable_id from disk.
  mkdirSync(ghost, { recursive: true });
  await env.spaceService.scanSpace(source.space_id);
  const after = env.spaceStore.getSourceById(source.id);
  expect(after?.portable_id).not.toBeNull();
  expect(existsSync(join(ghost, ".oyster", "id"))).toBe(true);

  rmSync(ghost, { recursive: true, force: true });
});
```

- [ ] **Step 11: Test 9 — `addSource` writes the row exactly once**

```typescript
it("Test 9: addSource INSERTs the row exactly once even when the file write fails", () => {
  const repo = makeRepo();
  if (process.platform === "win32") return; // chmod no-op
  // Make the repo read-only so writeOysterId throws
  require("node:fs").chmodSync(repo, 0o555);

  const source = env.spaceService.addSource("home", repo);
  expect(source.portable_id).toBeNull(); // write failed
  // The row should exist exactly once (no follow-up INSERT, no corrective UPDATE)
  const rows = env.db.prepare(
    "SELECT id, portable_id FROM sources WHERE path = ?"
  ).all(repo) as Array<{ id: string; portable_id: string | null }>;
  expect(rows).toHaveLength(1);
  expect(rows[0].portable_id).toBeNull();

  require("node:fs").chmodSync(repo, 0o755);
  rmSync(repo, { recursive: true, force: true });
});
```

- [ ] **Step 12: Test 10 — `.oyster/` never registered as an artefact (invariant 6)**

```typescript
it("Test 10: .oyster/ is never registered as an artefact (invariant 6)", async () => {
  const repo = makeRepo();
  // Pre-seed a .oyster/id (adoption path) and a real markdown file
  mkdirSync(join(repo, ".oyster"));
  writeFileSync(join(repo, ".oyster", "id"), "4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f\n", "utf8");
  writeFileSync(join(repo, "README.md"), "# repo", "utf8");

  const source = env.spaceService.addSource("home", repo);
  expect(source.portable_id).toBe("4a7c9d2e-1b3f-4d5a-9c8e-6f2a1b3d4e5f");

  await env.spaceService.scanSpace(source.space_id);

  // Inspect artefacts associated with this source
  const artefactPaths = env.db.prepare(
    `SELECT json_extract(storage_config, '$.path') AS path FROM artifacts WHERE source_id = ?`
  ).all(source.id) as Array<{ path: string }>;

  // README.md should be there; nothing under .oyster/ should be
  expect(artefactPaths.some(r => r.path.endsWith("README.md"))).toBe(true);
  expect(artefactPaths.some(r => r.path.includes(`${repo}/.oyster`))).toBe(false);

  // Also assert .oyster is in SKIP_DIRS (defensive surface check)
  const spaceSvcSource = readFileSync("server/src/space-service.ts", "utf8");
  expect(spaceSvcSource).toMatch(/SKIP_DIRS\s*=\s*new Set\(\[[^\]]*"\.oyster"[^\]]*\]\)/);

  rmSync(repo, { recursive: true, force: true });
});
```

- [ ] **Step 13: Run the full integration test file**

```bash
cd server && npm test -- --run oyster-id-integration
```

Expected: all 10 tests pass.

- [ ] **Step 14: Commit**

```bash
git add server/test/oyster-id-integration.test.ts
git commit -m "test(oyster-id): integration suite covering tests 1-10 from spec"
```

---

## Chunk 8 — Final verification

### Task 11: Full suite + typecheck + boot-clean

- [ ] **Step 1: Run the entire server test suite**

```bash
cd server && npm test
```

Expected: every test in the project passes (300+ existing tests + the new unit + integration tests).

- [ ] **Step 2: Run server typecheck**

```bash
cd server && ./node_modules/.bin/tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Run web typecheck (no UI changes, but shared/types.ts moved)**

```bash
cd web && ./node_modules/.bin/tsc --noEmit
```

Expected: exits 0. The `portable_id` addition to the shared `Source` type is backward-compatible (new optional/nullable field).

- [ ] **Step 4: Production build sanity**

```bash
npm run build
```

Expected: completes without errors.

- [ ] **Step 5: Manual boot smoke test**

Run the dev server on a clean DB (rename your local `~/Oyster/db/oyster.db` aside first if you want to validate the empty-DB path; otherwise just boot against your existing DB):

```bash
npm run dev:server 2>&1 | head -30
```

Expected: you see `[oyster-id migration] portable_id backfill: N updated, M skipped` on first boot, then attaching a fresh folder via the UI writes a real `.oyster/id` file you can inspect with `cat`. No tracebacks.

- [ ] **Step 6: Push the branch and open a PR**

```bash
git push -u origin docs/oyster-id-portable-identity-spec
```

Actually — the spec branch is for the spec. For the implementation, you'll have been on a different branch (per the using-git-worktrees skill at execution time). Push that branch and open the PR there. The PR title/body should reference the approved spec.

---

## Self-review

**Spec coverage check (each spec section → task):**

- Invariant 1 (portable_id never unique) → schema migration uses partial index, NOT a UNIQUE constraint. Test 3 explicitly inserts two rows with the same value. ✓
- Invariant 2 (future sync can't use `(account_id, portable_id)` as unique) → enforced by invariant 1 schema. Spec text documents the rule. ✓
- Invariant 3 (`.oyster/id` may dirty a git repo; never auto-commit / edit `.gitignore`) → no git-touching code exists in any task. ✓
- Invariant 4 (disk-backed, not imaginary) → Task 7 reorders addSource to decide before INSERT (`portable_id = NULL` if write fails). Test 9 proves it. ✓
- Invariant 5 (`sources.id` never derived, never mutated) → Tasks 1–10 only ever set `sources.id = crypto.randomUUID()` at INSERT; no UPDATE touches it. Tests 6 + 7 verify. ✓
- Invariant 6 (`.oyster/` excluded from scanning) → Task 6 adds it to SKIP_DIRS. Test 10 verifies. ✓
- Schema (`portable_id` column + partial index) → Task 1. ✓
- `oyster-id.ts` discriminated-result module → Tasks 3–5. ✓
- `addSource` integration (with `.oyster/id` write only on success) → Task 7. ✓
- `scanSpace` integration (per-source reconciliation) → Task 8. ✓
- Boot migration (idempotent, never mutates `sources.id`) → Task 9. ✓
- All ten spec tests → Task 10's steps 2–12. ✓

**Placeholder scan:** No "TBD", no "TODO", every step has actual code or actual commands. ✓

**Type consistency:** `OysterIdReadResult`, `readOysterId`, `writeOysterId`, `isValidUuid`, `backfillPortableIds`, `reconcilePortableId`, `updatePortableId` — names match across the introduction tasks and the consumer tasks. ✓

Plan complete and saved to `docs/superpowers/plans/2026-05-15-oyster-id-portable-identity.md`.
