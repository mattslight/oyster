# R5 Publish UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Publish UI for #317 — entry points (right-click context menu, viewer header Share button, `/p` slash command), a `PublishModal` covering five visible states, a `PublishedChip` on tiles with one-click copy, plus the local-server plumbing needed to feed the UI (artefact wire-format extension and `artifact_changed` SSE).

**Architecture:** Backend (#315/#316) is already in production — the `publish_artifact` / `unpublish_artifact` MCP tools, the `POST` / `DELETE /api/artifacts/:id/publish` HTTP routes, the `oyster-publish` Worker, and the public viewer all work end-to-end. This PR adds (a) a nested `publication` object on the wire format so the client can render published state, (b) an `artifact_changed` SSE broadcast at the call sites of the publish routes and MCP tools so the UI updates in real time, and (c) all the React components, hooks, and integration glue.

**Tech Stack:** TypeScript across the board. Server uses Node + better-sqlite3 + Vitest. Web uses React 19 + Vite + Lucide icons + (new) `qrcode-generator` for QR rendering. No new server-side dependencies; one new web dependency (`qrcode-generator`).

**Spec:** [`docs/superpowers/specs/2026-05-04-r5-publish-ui-design.md`](../specs/2026-05-04-r5-publish-ui-design.md) — read this first if you haven't already.

**Tracks:** Issue #317. Worktree: `~/Dev/oyster-os.worktrees/317-publish-ui` on branch `feat/publish-ui`.

---

## Important: Test coverage deviation from spec

The spec lists web-side unit tests under "Unit (Vitest, web/src)". **The web codebase has no test infrastructure today** — no Vitest, no React Testing Library, no test files. Setting it up is a meaningful chunk of work that's out of scope for this PR.

This plan therefore covers:

- **Server-side Vitest tests** for the wire-format extension and the SSE broadcast points (existing infra, easy to extend).
- **Manual smoke** against the deployed Worker for the UI surface.
- **No web-side unit tests.** Filed as follow-up: "Set up Vitest + React Testing Library in `web/`".

This is a documented deviation from the spec. The PR description should call it out.

---

## File structure

### Files created

| Path | Responsibility |
|---|---|
| `web/src/components/PublishModal.tsx` | The modal component. Drives the five visible states (unpublished, signed-out, in-flight, published, error). |
| `web/src/components/PublishModal.css` | Styles for the modal, URL trophy, mode picker, footer. |
| `web/src/components/PublishedChip.tsx` | Tile chip — "Published" / "Password" tag plus adjacent copy-link icon. |
| `web/src/components/PublishedChip.css` | Styles for the chip. |
| `web/src/data/publish-api.ts` | HTTP client for `POST` / `DELETE /api/artifacts/:id/publish`. |
| `web/src/hooks/useCopyLink.ts` | Shared hook for "copy URL → flash ✓" affordance, used by chip and modal. |
| `server/test/artifact-service.test.ts` | New Vitest file for the wire-format mapping (publication camelCase). |
| `server/test/publish-route.test.ts` | New Vitest file for the SSE broadcast at the publish route. |

### Files modified

| Path | What changes |
|---|---|
| `shared/types.ts` | Add `ArtefactPublication` interface and `publication?: ArtefactPublication \| null` on `Artifact`. |
| `server/src/artifact-store.ts` | Add `share_token`, `share_mode`, `share_password_hash`, `published_at`, `share_updated_at`, `unpublished_at` to `ArtifactRow`. Update SELECT statements to read them. |
| `server/src/artifact-service.ts` | In the row-to-wire mapper, build a `publication` sub-object when `share_token` is non-NULL. |
| `server/src/routes/publish.ts` | Take `broadcastUiEvent` in the deps; call it with `artifact_changed` after a successful POST or DELETE. |
| `server/src/mcp-server.ts` | In the `publish_artifact` and `unpublish_artifact` tool handlers, call `broadcastUiEvent` after the service returns. |
| `server/src/index.ts` | Pass `broadcastUiEvent` into the publish-route deps. |
| `web/src/App.tsx` | (a) Mount `PublishModal` at App-shell level. (b) Subscribe to `artifact_changed` SSE and refetch the artefact list. (c) Thread an `onArtifactPublish` opener through `Desktop`, `ViewerWindow`, and `ChatBar`. |
| `web/src/components/ArtifactIcon.tsx` | Render `<PublishedChip>` after the label when `artifact.publication?.unpublishedAt == null`. |
| `web/src/components/Desktop.tsx` | Add "Publish…" / "Manage publication…" entry to the artefact context menu. Gate on `builtin`, `plugin`, `status === "generating"`, `isArchivedView`. |
| `web/src/components/ViewerWindow.tsx` | Optional `onShare?: () => void` and `shareDisabled?: boolean` props; render a Share button in the chrome header when `onShare` provided and `!shareDisabled`. |
| `web/src/components/WindowChrome.tsx` | Optional `extraHeader?: ReactNode` slot in the title bar so ViewerWindow can mount the Share button without a chrome rewrite. |
| `web/src/components/ChatBar.tsx` | Add `/p` to `SLASH_COMMANDS`, score artefacts (filtered for publishability), wire `cmd === 'p'` in `handleSend`. New `onArtifactPublish?` prop. |
| `web/package.json` | Add `qrcode-generator` runtime dependency. |
| `CHANGELOG.md` | One bullet under Added. |

### Files NOT touched

`server/src/publish-service.ts`, `server/src/db.ts`, `infra/oyster-publish/*`, `infra/auth-worker/*`. Backend behaviour is unchanged. The DB schema columns are already present from #314 and #315 — we only need to read them.

---

## Pre-flight check

Before starting any task, verify the worktree environment is set up:

```bash
cd ~/Dev/oyster-os.worktrees/317-publish-ui
git status                # should be clean on feat/publish-ui
test -f .env || cp ../../oyster-os/.env .env
cd web && npm install
cd ../server && npm install
cd ..
```

If the dev server is going to run during smoke tests, start it separately in another terminal: `npm run dev` from the worktree root. The Vite dev server runs at `http://localhost:7337` and proxies `/api/*` to the server at `:3333`.

---

## Phase 1 — Server-side wire format

### Task 1: Extend `ArtifactRow` and SELECT statements with share_* columns

**Files:**
- Modify: `server/src/artifact-store.ts`

**Why:** SQLite already has the share columns (added in #314/#315 ALTERs). The `ArtifactRow` interface and the `SELECT *` queries in `SqliteArtifactStore` don't include them, so `share_token` etc. never reach the wire mapper. Step one is just exposing the columns to the row type.

- [ ] **Step 1: Read the current row type and SELECT statements**

```bash
grep -n "ArtifactRow\|SELECT \*\|SELECT .* FROM artifacts\b" server/src/artifact-store.ts | head -20
```

The row type is around line 5; the prepared statements are typically near the constructor.

- [ ] **Step 2: Add share fields to `ArtifactRow`**

Add to the interface in `server/src/artifact-store.ts` (top of file, right after `updated_at`):

```ts
export interface ArtifactRow {
  // …existing fields up to updated_at…
  share_token: string | null;
  share_mode: "open" | "password" | "signin" | null;
  share_password_hash: string | null;
  published_at: number | null;
  share_updated_at: number | null;
  unpublished_at: number | null;
}
```

- [ ] **Step 3: Confirm the SELECT statements use `*`**

If the prepared statements use `SELECT *`, no further query change is needed — better-sqlite3 returns all columns. If they enumerate columns explicitly (`SELECT id, label, …`), append the six share columns.

```bash
grep -nE "SELECT [^*]+FROM artifacts" server/src/artifact-store.ts
```

If matches print, edit each to include the six share columns.

- [ ] **Step 4: Build to confirm types**

```bash
cd server && npm run build
```

Expected: clean. If TypeScript complains that some downstream consumer of `ArtifactRow` doesn't handle the new nullable fields, leave them as `| null` and don't add fallback logic — those consumers ignore the columns by ignoring the field name.

- [ ] **Step 5: Commit**

```bash
git add server/src/artifact-store.ts
git commit -m "feat(317): expose share_* columns on ArtifactRow"
```

---

### Task 2: Map `publication` into the artefact wire format

**Files:**
- Modify: `server/src/artifact-service.ts` (the row-to-wire mapper, around lines 540-602)
- Create: `server/test/artifact-service.test.ts`

**Why:** Wire format is the contract the React client reads from `/api/artifacts`. The mapper currently builds an `Artifact` object without `publication`. Adding the nested object is the one server-side change that drives the chip.

- [ ] **Step 1: Write the failing test**

Create `server/test/artifact-service.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ArtifactService } from "../src/artifact-service.js";
import { SqliteArtifactStore } from "../src/artifact-store.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE artifacts (
      id                   TEXT PRIMARY KEY,
      owner_id             TEXT,
      space_id             TEXT NOT NULL,
      label                TEXT NOT NULL,
      artifact_kind        TEXT NOT NULL,
      storage_kind         TEXT NOT NULL DEFAULT 'filesystem',
      storage_config       TEXT NOT NULL DEFAULT '{}',
      runtime_kind         TEXT NOT NULL DEFAULT 'static_file',
      runtime_config       TEXT NOT NULL DEFAULT '{}',
      group_name           TEXT,
      removed_at           TEXT,
      source_origin        TEXT NOT NULL DEFAULT 'manual',
      source_ref           TEXT,
      source_id            TEXT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
      share_token          TEXT,
      share_mode           TEXT,
      share_password_hash  TEXT,
      published_at         INTEGER,
      share_updated_at     INTEGER,
      unpublished_at       INTEGER
    );
  `);
  return db;
}

function seed(db: Database.Database, fields: Partial<{ id: string; share_token: string | null; share_mode: string | null; published_at: number | null; share_updated_at: number | null; unpublished_at: number | null }> = {}) {
  const id = fields.id ?? "art_1";
  db.prepare(
    `INSERT INTO artifacts
       (id, space_id, label, artifact_kind, storage_kind, storage_config,
        runtime_kind, runtime_config, share_token, share_mode, published_at,
        share_updated_at, unpublished_at)
     VALUES (?, 'home', 'Test artefact', 'notes', 'filesystem', '{"path":"/tmp/x.md"}',
             'static_file', '{}', ?, ?, ?, ?, ?)`
  ).run(
    id,
    fields.share_token ?? null,
    fields.share_mode ?? null,
    fields.published_at ?? null,
    fields.share_updated_at ?? null,
    fields.unpublished_at ?? null,
  );
  return id;
}

describe("artifact wire format — publication", () => {
  let db: Database.Database;
  let service: ArtifactService;

  beforeEach(() => {
    db = makeDb();
    const store = new SqliteArtifactStore(db);
    // ArtifactService constructor signature may vary — adapt to whichever
    // overload exists in src/artifact-service.ts. The point is to get a
    // service whose getAllArtifacts() runs the row-to-wire mapper.
    service = new ArtifactService({
      store,
      workerBase: "https://oyster.to",
      // …other deps as required by the actual constructor (icon generator,
      // space store, etc.). Pass minimal stubs.
    } as any);
  });

  it("omits the publication field when share_token is NULL", async () => {
    seed(db);
    const [a] = await service.getAllArtifacts(() => {});
    expect(a.publication).toBeUndefined();
  });

  it("emits a live publication when share_token is set and unpublished_at is NULL", async () => {
    seed(db, {
      share_token: "Hk3qm9p_ZxN",
      share_mode: "open",
      published_at: 1717000000000,
      share_updated_at: 1717000000000,
    });
    const [a] = await service.getAllArtifacts(() => {});
    expect(a.publication).toEqual({
      shareToken: "Hk3qm9p_ZxN",
      shareUrl: "https://oyster.to/p/Hk3qm9p_ZxN",
      shareMode: "open",
      publishedAt: 1717000000000,
      updatedAt: 1717000000000,
      unpublishedAt: null,
    });
  });

  it("emits a retired publication when unpublished_at is set", async () => {
    seed(db, {
      share_token: "Hk3qm9p_ZxN",
      share_mode: "password",
      published_at: 1717000000000,
      share_updated_at: 1717000000500,
      unpublished_at: 1717000005000,
    });
    const [a] = await service.getAllArtifacts(() => {});
    expect(a.publication?.unpublishedAt).toBe(1717000005000);
    expect(a.publication?.shareMode).toBe("password");
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

```bash
cd server && npm test -- artifact-service.test.ts
```

Expected: FAIL — most likely "publication is undefined" on the second test, or constructor signature mismatch on stubs. If the constructor mismatches, adapt the stubs to match the real shape but keep them minimal.

- [ ] **Step 3: Add `workerBase` to the service deps and `publication` to the mapper**

In `server/src/artifact-service.ts`:

1. Add `workerBase: string` to the deps interface for the service (mirror the same field in `publish-service.ts`).
2. Wire it through where the service is constructed — `server/src/index.ts` already creates the publish-service with `workerBase`; pass the same value to the artefact-service.
3. In the row-to-wire mapper (currently around lines 561 and 587 — both branches need the same logic), add:

```ts
const publication = row.share_token
  ? {
      shareToken: row.share_token,
      shareUrl: `${this.workerBase}/p/${row.share_token}`,
      shareMode: row.share_mode!,
      publishedAt: row.published_at!,
      updatedAt: row.share_updated_at!,
      unpublishedAt: row.unpublished_at,  // null when live
    }
  : undefined;
```

Then spread `...(publication ? { publication } : {})` into the returned object so the field is omitted from JSON when undefined.

- [ ] **Step 4: Run the test, expect pass**

```bash
cd server && npm test -- artifact-service.test.ts
```

Expected: PASS on all three cases.

- [ ] **Step 5: Confirm the rest of the test suite still passes**

```bash
cd server && npm test
```

Expected: full suite green.

- [ ] **Step 6: Commit**

```bash
git add server/src/artifact-service.ts server/test/artifact-service.test.ts
git commit -m "feat(317): emit publication sub-object on artefact wire format"
```

---

### Task 3: Extend `shared/types.ts` with `ArtefactPublication`

**Files:**
- Modify: `shared/types.ts`

**Why:** The web client reads from this single shared types module. The server already emits the new field in JSON; the client needs a type for it.

- [ ] **Step 1: Add the new interface and field**

Open `shared/types.ts`. Below the existing `Artifact` interface, add:

```ts
export interface ArtefactPublication {
  shareToken: string;
  shareUrl: string;
  shareMode: "open" | "password" | "signin";
  publishedAt: number;
  updatedAt: number;
  unpublishedAt: number | null;  // null = live; non-null = retired
}
```

In the `Artifact` interface (after `sourceId?`), add:

```ts
  /** Cloud publication state for this artefact. Omitted entirely when no
   *  share token has ever been minted. When present with `unpublishedAt: null`
   *  the artefact is currently public; when `unpublishedAt` is non-null the
   *  publication has been retired (chip hides; URL serves 410). */
  publication?: ArtefactPublication | null;
```

- [ ] **Step 2: Build both server and web to verify types compile**

```bash
cd server && npm run build && cd ../web && npm run build
```

Expected: clean. If web complains about an unused import, that's fine — the field is optional and unused at this point.

- [ ] **Step 3: Commit**

```bash
git add shared/types.ts
git commit -m "feat(317): add ArtefactPublication to shared types"
```

---

## Phase 2 — Server-side SSE broadcast

### Task 4: Broadcast `artifact_changed` from the publish HTTP route

**Files:**
- Modify: `server/src/routes/publish.ts`
- Modify: `server/src/index.ts` (deps wiring)
- Create: `server/test/publish-route.test.ts`

**Why:** Per the spec, the broadcast happens at the call site, not inside `publish-service.ts`. The route is the call site for HTTP callers; it currently only proxies success/error responses. Add `broadcastUiEvent` to its deps and call it post-success.

- [ ] **Step 1: Write the failing test**

Create `server/test/publish-route.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { tryHandlePublishRoute } from "../src/routes/publish.js";

function fakeReqRes(method: "POST" | "DELETE", body: any = {}) {
  const captured: { status?: number; json?: any } = {};
  const ctx = {
    sendJson: (j: any, s = 200) => { captured.json = j; captured.status = s; },
    rejectIfNonLocalOrigin: () => false,
    readJsonBody: async () => body,
  };
  const req = { method } as any;
  const res = {} as any;
  return { req, res, ctx, captured };
}

describe("routes/publish — SSE broadcast", () => {
  it("broadcasts artifact_changed after a successful POST", async () => {
    const broadcast = vi.fn();
    const publishService = {
      publishArtifact: vi.fn().mockResolvedValue({
        share_token: "tok", share_url: "https://oyster.to/p/tok",
        mode: "open", published_at: 1, updated_at: 1,
      }),
      unpublishArtifact: vi.fn(),
    };
    const { req, res, ctx } = fakeReqRes("POST", { mode: "open" });
    const handled = await tryHandlePublishRoute(req, res,
      "/api/artifacts/art_1/publish", ctx as any, {
        publishService: publishService as any,
        broadcastUiEvent: broadcast,
      });
    expect(handled).toBe(true);
    expect(broadcast).toHaveBeenCalledWith({
      version: 1, command: "artifact_changed", payload: { id: "art_1" },
    });
  });

  it("broadcasts artifact_changed after a successful DELETE", async () => {
    const broadcast = vi.fn();
    const publishService = {
      publishArtifact: vi.fn(),
      unpublishArtifact: vi.fn().mockResolvedValue({
        ok: true, share_token: "tok", unpublished_at: 99,
      }),
    };
    const { req, res, ctx } = fakeReqRes("DELETE");
    await tryHandlePublishRoute(req, res,
      "/api/artifacts/art_1/publish", ctx as any, {
        publishService: publishService as any,
        broadcastUiEvent: broadcast,
      });
    expect(broadcast).toHaveBeenCalledWith({
      version: 1, command: "artifact_changed", payload: { id: "art_1" },
    });
  });

  it("does NOT broadcast on a failed publish", async () => {
    const broadcast = vi.fn();
    const publishService = {
      publishArtifact: vi.fn().mockRejectedValue(
        Object.assign(new Error("nope"), { status: 401, code: "sign_in_required", details: {} })
      ),
      unpublishArtifact: vi.fn(),
    };
    const { req, res, ctx } = fakeReqRes("POST", { mode: "open" });
    await tryHandlePublishRoute(req, res,
      "/api/artifacts/art_1/publish", ctx as any, {
        publishService: publishService as any,
        broadcastUiEvent: broadcast,
      });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

```bash
cd server && npm test -- publish-route.test.ts
```

Expected: FAIL — broadcast called 0 times because the route doesn't broadcast yet.

- [ ] **Step 3: Add `broadcastUiEvent` to the route deps and call it**

In `server/src/routes/publish.ts`:

```ts
import type { UiCommand } from "../../../shared/types.js";

export interface PublishRouteDeps {
  publishService: PublishService;
  broadcastUiEvent: (event: UiCommand) => void;
}
```

In the POST branch, after `sendJson(result)`:

```ts
deps.broadcastUiEvent({
  version: 1,
  command: "artifact_changed",
  payload: { id: artifactId },
});
```

In the DELETE branch, after `sendJson(result)`:

```ts
deps.broadcastUiEvent({
  version: 1,
  command: "artifact_changed",
  payload: { id: artifactId },
});
```

- [ ] **Step 4: Wire `broadcastUiEvent` into the route deps in `index.ts`**

Find where `tryHandlePublishRoute` is called in `server/src/index.ts` (or where the route deps object is constructed). Add `broadcastUiEvent` to the deps:

```bash
grep -n "tryHandlePublishRoute\|publishService" server/src/index.ts
```

The route is invoked in the request dispatcher; the deps object lives nearby. Add `broadcastUiEvent` (already available locally — it's defined at line 353 of `index.ts`).

- [ ] **Step 5: Run the test, expect pass**

```bash
cd server && npm test -- publish-route.test.ts
```

Expected: PASS on all three cases.

- [ ] **Step 6: Confirm the full server test suite still passes**

```bash
cd server && npm test
```

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/publish.ts server/src/index.ts server/test/publish-route.test.ts
git commit -m "feat(317): broadcast artifact_changed from publish HTTP route"
```

---

### Task 5: Broadcast `artifact_changed` from the MCP publish/unpublish tools

**Files:**
- Modify: `server/src/mcp-server.ts` (the `publish_artifact` and `unpublish_artifact` handlers, around line 693+)

**Why:** Agents publish via MCP, not HTTP. The broadcast must fire for both call paths so the UI updates regardless of who triggered the publish.

- [ ] **Step 1: Locate the tool handlers**

```bash
grep -n "publish_artifact\|unpublish_artifact" server/src/mcp-server.ts | head -10
```

The handlers are around lines 693+ (existing `broadcastUiEvent` calls live nearby for context).

- [ ] **Step 2: Add the broadcast after a successful publish**

In the `publish_artifact` handler, after `await publishService.publishArtifact(...)` returns successfully and before the response is built, add:

```ts
deps.broadcastUiEvent({
  version: 1,
  command: "artifact_changed",
  payload: { id: args.artifact_id },
});
```

(`args.artifact_id` is the input arg name in the existing handler; if the local variable is named differently, use whatever the existing code calls it.)

- [ ] **Step 3: Add the broadcast after a successful unpublish**

Same shape, in the `unpublish_artifact` handler:

```ts
deps.broadcastUiEvent({
  version: 1,
  command: "artifact_changed",
  payload: { id: args.artifact_id },
});
```

- [ ] **Step 4: Build the server**

```bash
cd server && npm run build
```

Expected: clean.

- [ ] **Step 5: Manual smoke — call the MCP tool and watch SSE**

In one terminal: `cd ~/Dev/oyster-os.worktrees/317-publish-ui && npm run dev`. In another: `curl -N http://localhost:3333/api/ui/events` (this opens an SSE stream and prints events as they arrive).

Trigger a publish via the MCP CLI or by hitting `POST /api/artifacts/<id>/publish` with `curl`:

```bash
curl -X POST http://localhost:3333/api/artifacts/<some-published-id>/publish \
  -H 'content-type: application/json' \
  -d '{"mode":"open"}' \
  --cookie 'oyster_session=<session>'
```

Expected: SSE stream prints `{"command":"artifact_changed","payload":{"id":"<some-published-id>"}}`. (And the same on unpublish.) If sign-in or anything else is needed, do it through the surface first to mint a session.

- [ ] **Step 6: Commit**

```bash
git add server/src/mcp-server.ts
git commit -m "feat(317): broadcast artifact_changed from publish_artifact MCP tool"
```

---

## Phase 3 — Web data layer

### Task 6: Add the `qrcode-generator` dependency

**Files:**
- Modify: `web/package.json`

**Why:** The QR toggle in the published-state modal needs a tiny lib. `qrcode-generator` is ~6 KB, no DOM, no peer deps; it returns a string of paths that we render inside an inline SVG.

- [ ] **Step 1: Install**

```bash
cd web && npm install qrcode-generator
```

- [ ] **Step 2: Verify the package landed**

```bash
grep -A1 'qrcode-generator' web/package.json
```

- [ ] **Step 3: Commit**

```bash
git add web/package.json web/package-lock.json
git commit -m "chore(317): add qrcode-generator for the publish modal QR toggle"
```

---

### Task 7: Create `publish-api.ts` data layer

**Files:**
- Create: `web/src/data/publish-api.ts`

**Why:** Mirrors `data/artifacts-api.ts` — a thin module of typed functions wrapping `fetch`. Keeps `PublishModal` free of fetch glue.

- [ ] **Step 1: Read the existing http helpers to match the style**

```bash
head -40 web/src/data/http.ts
```

- [ ] **Step 2: Create the module**

```ts
// web/src/data/publish-api.ts

import type { ArtefactPublication } from "../../../shared/types";

/** Result of a successful publish. Mirrors PublishResult from server/src/publish-service.ts. */
export interface PublishResponse {
  share_token: string;
  share_url: string;
  mode: "open" | "password" | "signin";
  published_at: number;
  updated_at: number;
}

/** Result of a successful unpublish. */
export interface UnpublishResponse {
  ok: true;
  share_token: string;
  unpublished_at: number;
}

/** Server error envelope. The server proxies this verbatim from the Worker. */
export interface PublishErrorBody {
  error: string;
  message?: string;
  [key: string]: unknown;
}

export class PublishApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PublishApiError";
  }
}

async function send<T>(
  method: "POST" | "DELETE",
  artifactId: string,
  body?: { mode: string; password?: string },
): Promise<T> {
  const res = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/publish`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as PublishErrorBody;
    const code = json.error ?? "unknown_error";
    const { error: _e, message: _m, ...details } = json;
    throw new PublishApiError(res.status, code, json.message ?? code, details);
  }
  return (await res.json()) as T;
}

export function publishArtifact(
  artifactId: string,
  mode: "open" | "password",
  password?: string,
): Promise<PublishResponse> {
  return send<PublishResponse>("POST", artifactId, { mode, password });
}

export function unpublishArtifact(artifactId: string): Promise<UnpublishResponse> {
  return send<UnpublishResponse>("DELETE", artifactId);
}

/** Helper used by the chip and modal to derive "is currently live" from a publication. */
export function isLive(publication: ArtefactPublication | null | undefined): publication is ArtefactPublication {
  return !!publication && publication.unpublishedAt === null;
}
```

- [ ] **Step 3: Build the web package to confirm it compiles**

```bash
cd web && npm run build
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add web/src/data/publish-api.ts
git commit -m "feat(317): add publish-api data layer"
```

---

### Task 8: Add the `useCopyLink` hook

**Files:**
- Create: `web/src/hooks/useCopyLink.ts`

**Why:** Both `PublishedChip` (icon button on tile) and `PublishModal` (Copy button) need identical "copy → flash ✓ for ~1.2 s → fade back" behaviour. A shared hook keeps it consistent.

- [ ] **Step 1: Create the hook**

```ts
// web/src/hooks/useCopyLink.ts

import { useCallback, useEffect, useRef, useState } from "react";

interface UseCopyLink {
  /** True for ~1.2 s after a successful copy. Drives the green-✓ render branch. */
  copied: boolean;
  /** True after a copy that errored (clipboard access denied / no clipboard API). */
  failed: boolean;
  /** Trigger the copy. Returns the promise so callers can await if needed. */
  copy: () => Promise<void>;
}

const FLASH_MS = 1200;

export function useCopyLink(url: string): UseCopyLink {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);

  const copy = useCallback(async () => {
    setFailed(false);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        // Fallback for environments without the async clipboard API.
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (!ok) throw new Error("execCommand copy failed");
      }
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), FLASH_MS);
    } catch (err) {
      console.error("[publish] copy failed:", err);
      setFailed(true);
    }
  }, [url]);

  return { copied, failed, copy };
}
```

- [ ] **Step 2: Build to confirm**

```bash
cd web && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add web/src/hooks/useCopyLink.ts
git commit -m "feat(317): add useCopyLink hook for shared copy feedback"
```

---

## Phase 4 — `PublishedChip`

### Task 9: Create `PublishedChip` component

**Files:**
- Create: `web/src/components/PublishedChip.tsx`
- Create: `web/src/components/PublishedChip.css`

**Why:** Chip lives below the artefact label on tiles whose publication is live. Tag is informational only; the icon button is the one click target. Mode-tinted: Open is purple, Password is amber with a lock prefix.

- [ ] **Step 1: Create the CSS**

```css
/* web/src/components/PublishedChip.css */

.published-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 3px;
  user-select: none;
}

.published-chip__tag {
  font-size: 8.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 1px 7px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: #a78bfa;
  background: rgba(167, 139, 250, 0.12);
}

.published-chip__tag--password {
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.12);
}

.published-chip__btn {
  width: 14px;
  height: 14px;
  padding: 0;
  border: none;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  background: rgba(167, 139, 250, 0.12);
  color: #a78bfa;
  transition: background 0.15s ease;
}

.published-chip__btn:hover {
  background: rgba(167, 139, 250, 0.28);
}

.published-chip__btn--password {
  background: rgba(251, 191, 36, 0.12);
  color: #fbbf24;
}

.published-chip__btn--password:hover {
  background: rgba(251, 191, 36, 0.28);
}

.published-chip__btn--copied {
  background: rgba(74, 222, 128, 0.18) !important;
  color: #4ade80;
}
```

- [ ] **Step 2: Create the component**

```tsx
// web/src/components/PublishedChip.tsx

import { Link2, Check, Lock } from "lucide-react";
import type { ArtefactPublication } from "../../../shared/types";
import { useCopyLink } from "../hooks/useCopyLink";
import "./PublishedChip.css";

interface Props {
  publication: ArtefactPublication;
}

export function PublishedChip({ publication }: Props) {
  const { copied, copy } = useCopyLink(publication.shareUrl);
  const isPassword = publication.shareMode === "password";
  const tagClass = `published-chip__tag${isPassword ? " published-chip__tag--password" : ""}`;
  const btnClass = `published-chip__btn${isPassword ? " published-chip__btn--password" : ""}${copied ? " published-chip__btn--copied" : ""}`;

  return (
    <span className="published-chip">
      <span className={tagClass} title={publication.shareUrl}>
        {isPassword && <Lock size={9} strokeWidth={2.5} />}
        Published
      </span>
      <button
        type="button"
        className={btnClass}
        title={copied ? "Copied" : "Copy link"}
        onClick={(e) => {
          e.stopPropagation();
          void copy();
        }}
      >
        {copied ? <Check size={9} strokeWidth={3} /> : <Link2 size={9} strokeWidth={2.4} />}
      </button>
    </span>
  );
}
```

- [ ] **Step 3: Build**

```bash
cd web && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add web/src/components/PublishedChip.tsx web/src/components/PublishedChip.css
git commit -m "feat(317): add PublishedChip component"
```

---

### Task 10: Mount `PublishedChip` inside `ArtifactIcon`

**Files:**
- Modify: `web/src/components/ArtifactIcon.tsx`

**Why:** The chip renders below the artefact label, after any showMeta line. Render only when `publication?.unpublishedAt === null`.

- [ ] **Step 1: Add the import**

At the top of `web/src/components/ArtifactIcon.tsx`:

```tsx
import { PublishedChip } from "./PublishedChip";
```

- [ ] **Step 2: Render the chip after the label / showMeta block**

Locate the JSX block for the showMeta line (currently at lines 222-225). Right after that closing `})()}`, add:

```tsx
{!isRenaming && artifact.publication && artifact.publication.unpublishedAt === null && (
  <PublishedChip publication={artifact.publication} />
)}
```

- [ ] **Step 3: Build**

```bash
cd web && npm run build
```

- [ ] **Step 4: Manual smoke**

```bash
cd ~/Dev/oyster-os.worktrees/317-publish-ui && npm run dev
```

Open `http://localhost:7337`. Publish an artefact via MCP / curl (you can borrow the smoke command from Task 5). The tile should show the new chip below the label. Click the icon — tooltip says "Copy link"; click — flashes ✓ for ~1.2 s; URL is on your clipboard.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ArtifactIcon.tsx
git commit -m "feat(317): mount PublishedChip in ArtifactIcon"
```

---

## Phase 5 — `PublishModal`

The modal has five visible states (unpublished, signed-out, in-flight, published, error). Build it incrementally — each task adds one slice and stays runnable.

### Task 11: Skeleton modal — unpublished state only

**Files:**
- Create: `web/src/components/PublishModal.tsx`
- Create: `web/src/components/PublishModal.css`

- [ ] **Step 1: Create the CSS**

```css
/* web/src/components/PublishModal.css */

/* Reuses .confirm-modal-overlay / .confirm-modal-panel from ConfirmModal.css.
   Override + extend with publish-specific affordances. */

.publish-modal-panel {
  width: 380px;
  max-width: calc(100vw - 32px);
  background: #181a26;
  border: 1px solid #2d2f52;
  border-radius: 12px;
  padding: 20px;
  color: #e2e8f0;
  font-family: var(--font-system, system-ui);
}

.publish-modal-eyebrow {
  font-size: 13px;
  color: #94a3b8;
  margin-bottom: 4px;
}

.publish-modal-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 18px;
}

.publish-modal-error {
  font-size: 12px;
  color: #fca5a5;
  margin-bottom: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.publish-modal-error__retry {
  background: none;
  border: 1px solid #fca5a5;
  color: #fca5a5;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.publish-modal-modes {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 18px;
}

.publish-modal-mode {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  cursor: pointer;
  color: #cbd5e1;
}

.publish-modal-mode--selected {
  color: #e2e8f0;
}

.publish-modal-mode__radio {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid #475569;
  display: inline-block;
  position: relative;
  flex-shrink: 0;
}

.publish-modal-mode--selected .publish-modal-mode__radio {
  border-color: #a78bfa;
}

.publish-modal-mode--selected .publish-modal-mode__radio::after {
  content: "";
  position: absolute;
  inset: 2px;
  background: #a78bfa;
  border-radius: 50%;
}

.publish-modal-password {
  width: 100%;
  background: #0f1118;
  border: 1px solid #2d2f52;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13px;
  color: #e2e8f0;
  font-family: var(--font-system, system-ui);
  margin-bottom: 18px;
}

.publish-modal-password::placeholder {
  color: #64748b;
}

.publish-modal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.publish-modal-actions--published {
  justify-content: space-between;
}

.publish-modal-btn {
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  border: none;
  background: #2d2f52;
  color: #e2e8f0;
  font-family: var(--font-system, system-ui);
}

.publish-modal-btn--primary {
  background: #a78bfa;
  color: #0f1118;
  font-weight: 600;
}

.publish-modal-btn--cancel {
  background: none;
  color: #94a3b8;
}

.publish-modal-btn--unpublish {
  background: none;
  color: #fca5a5;
}

.publish-modal-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
```

- [ ] **Step 2: Create the component skeleton**

```tsx
// web/src/components/PublishModal.tsx

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Artifact } from "../../../shared/types";
import { publishArtifact, PublishApiError } from "../data/publish-api";
import "./PublishModal.css";

interface Props {
  /** The artefact being published. Null = modal closed. */
  artifact: Artifact | null;
  onClose: () => void;
}

type Mode = "open" | "password";
type Phase = "idle" | "publishing";

export function PublishModal({ artifact, onClose }: Props) {
  const [mode, setMode] = useState<Mode>("open");
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  // Reset internal state when the artefact changes (modal reopens on a different one).
  useEffect(() => {
    if (artifact) {
      setMode("open");
      setPassword("");
      setPhase("idle");
      setError(null);
    }
  }, [artifact?.id]);

  // Esc to close — but only when not in-flight.
  useEffect(() => {
    if (!artifact) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && phase === "idle") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [artifact, phase, onClose]);

  if (!artifact) return null;

  const canPublish = phase === "idle"
    && (mode === "open" || (mode === "password" && password.length > 0));

  async function handlePublish() {
    if (!artifact || !canPublish) return;
    setPhase("publishing");
    setError(null);
    try {
      await publishArtifact(artifact.id, mode, mode === "password" ? password : undefined);
      // Optimistic close on success — the SSE artifact_changed event will
      // trigger an artefact list refetch, which surfaces the chip and updates
      // any future re-open of the modal with the published state.
      onClose();
    } catch (err) {
      setPhase("idle");
      if (err instanceof PublishApiError) {
        setError(err.message || err.code);
      } else {
        setError("Couldn't publish — try again.");
      }
    }
  }

  function handleModeChange(next: Mode) {
    setMode(next);
    if (next === "open") setPassword("");  // see spec: switching to Open clears password
  }

  return createPortal(
    <div
      className="confirm-modal-overlay"
      onMouseDown={(e) => {
        if (phase === "idle" && e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="publish-modal-title"
    >
      <div className="publish-modal-panel">
        <div className="publish-modal-eyebrow">Publish artefact</div>
        <h2 id="publish-modal-title" className="publish-modal-title">{artifact.label}</h2>

        {error && (
          <div className="publish-modal-error">
            <span>{error}</span>
          </div>
        )}

        <div className="publish-modal-modes">
          <label className={`publish-modal-mode${mode === "open" ? " publish-modal-mode--selected" : ""}`}>
            <input type="radio" name="publish-mode" value="open" checked={mode === "open"} onChange={() => handleModeChange("open")} style={{ display: "none" }} />
            <span className="publish-modal-mode__radio" />
            <span><strong>Open</strong> · <span style={{ color: "#94a3b8" }}>anyone with the link</span></span>
          </label>
          <label className={`publish-modal-mode${mode === "password" ? " publish-modal-mode--selected" : ""}`}>
            <input type="radio" name="publish-mode" value="password" checked={mode === "password"} onChange={() => handleModeChange("password")} style={{ display: "none" }} />
            <span className="publish-modal-mode__radio" />
            <span><strong>Password</strong> · <span style={{ color: "#94a3b8" }}>link + password</span></span>
          </label>
        </div>

        {mode === "password" && (
          <input
            type="password"
            className="publish-modal-password"
            placeholder="Enter a password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        )}

        <div className="publish-modal-actions">
          <button type="button" className="publish-modal-btn publish-modal-btn--cancel" onClick={onClose} disabled={phase !== "idle"}>
            Cancel
          </button>
          <button type="button" className="publish-modal-btn publish-modal-btn--primary" onClick={handlePublish} disabled={!canPublish}>
            {phase === "publishing" ? "Publishing…" : "Publish"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 3: Build**

```bash
cd web && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add web/src/components/PublishModal.tsx web/src/components/PublishModal.css
git commit -m "feat(317): PublishModal skeleton with unpublished state"
```

---

### Task 12: Add the published state to `PublishModal`

**Files:**
- Modify: `web/src/components/PublishModal.tsx`
- Modify: `web/src/components/PublishModal.css`

**Why:** When the modal opens on an artefact whose `publication` is live, render the URL trophy + Copy + access picker (pre-selected) + Unpublish + Done. Save button shows only when mode picker differs from current OR password field is non-empty on Password mode.

- [ ] **Step 1: Add CSS for the URL trophy and section heading**

Append to `PublishModal.css`:

```css
.publish-modal-url {
  background: #0f1118;
  border: 1px solid #2d2f52;
  border-radius: 8px;
  padding: 14px;
  margin-bottom: 6px;
}

.publish-modal-url__text {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 13px;
  color: #a78bfa;
  word-break: break-all;
  margin-bottom: 10px;
  user-select: all;
}

.publish-modal-url__actions {
  display: flex;
  gap: 6px;
}

.publish-modal-url__copy {
  flex: 1;
  padding: 8px;
  background: #a78bfa;
  color: #0f1118;
  border: none;
  border-radius: 5px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.publish-modal-url__copy--copied {
  background: rgba(74, 222, 128, 0.85);
  color: #0f1118;
}

.publish-modal-url__qr-toggle {
  padding: 8px 12px;
  background: #2d2f52;
  color: #e2e8f0;
  border: none;
  border-radius: 5px;
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
}

.publish-modal-url__qr-toggle--active {
  background: #a78bfa;
  color: #0f1118;
}

.publish-modal-meta {
  font-size: 11px;
  color: #64748b;
  margin: 0 2px 18px;
}

.publish-modal-section-label {
  font-size: 11px;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 8px;
}

.publish-modal-helper {
  font-size: 12px;
  color: #94a3b8;
  margin-bottom: 14px;
  line-height: 1.5;
}
```

- [ ] **Step 2: Extend `PublishModal.tsx` to render the published state**

Add the imports at the top:

```tsx
import { Link2, Check } from "lucide-react";
import { useCopyLink } from "../hooks/useCopyLink";
import { unpublishArtifact } from "../data/publish-api";
import { ConfirmModal } from "./ConfirmModal";
```

Extend the `Phase` type:

```tsx
type Phase = "idle" | "publishing" | "unpublishing";
```

Inside the component, before the JSX `return`:

```tsx
const publication = artifact?.publication?.unpublishedAt === null ? artifact.publication : null;
const isPublished = !!publication;

// Pre-select the picker to the current mode when published.
useEffect(() => {
  if (publication) {
    if (publication.shareMode === "password" || publication.shareMode === "open") {
      setMode(publication.shareMode);
    } else {
      // signin — defensive: spec says the user must pick Open or Password to manage.
      // Don't pre-select either.
    }
    setPassword("");  // re-open: password field always empty per spec
  }
}, [publication?.shareToken]);

const { copied, copy } = useCopyLink(publication?.shareUrl ?? "");
const [showQr, setShowQr] = useState(false);
const [confirmUnpublish, setConfirmUnpublish] = useState(false);

const isSigninMode = publication?.shareMode === "signin";
const modeChanged = isPublished && publication.shareMode !== mode;
const passwordChange = isPublished && mode === "password" && password.length > 0;
const canSave = phase === "idle" && (modeChanged || passwordChange);

async function handleSave() {
  if (!artifact || !canSave) return;
  setPhase("publishing");
  setError(null);
  try {
    await publishArtifact(artifact.id, mode, mode === "password" ? password : undefined);
    setPassword("");
    setPhase("idle");
    // SSE will refetch and re-pin the picker to the new mode.
  } catch (err) {
    setPhase("idle");
    setError(err instanceof PublishApiError ? (err.message || err.code) : "Couldn't update — try again.");
  }
}

async function handleUnpublish() {
  if (!artifact) return;
  setConfirmUnpublish(false);
  setPhase("unpublishing");
  setError(null);
  try {
    await unpublishArtifact(artifact.id);
    // SSE will flip publication.unpublishedAt → modal returns to unpublished state.
    setPhase("idle");
  } catch (err) {
    setPhase("idle");
    setError(err instanceof PublishApiError ? (err.message || err.code) : "Couldn't unpublish — try again.");
  }
}
```

Replace the JSX body of the panel (everything after `<h2>` and before the modal closing `</div>`) with:

```tsx
        {error && (
          <div className="publish-modal-error">
            <span>{error}</span>
          </div>
        )}

        {isPublished && publication && (
          <>
            <div className="publish-modal-url">
              <div className="publish-modal-url__text">{publication.shareUrl}</div>
              <div className="publish-modal-url__actions">
                <button
                  type="button"
                  className={`publish-modal-url__copy${copied ? " publish-modal-url__copy--copied" : ""}`}
                  onClick={() => void copy()}
                >
                  {copied ? "Copied" : "Copy link"}
                </button>
                <button
                  type="button"
                  className={`publish-modal-url__qr-toggle${showQr ? " publish-modal-url__qr-toggle--active" : ""}`}
                  onClick={() => setShowQr((v) => !v)}
                  aria-label={showQr ? "Hide QR code" : "Show QR code"}
                >
                  <Link2 size={14} strokeWidth={2} />
                </button>
              </div>
              {/* QR canvas mounts in Task 13 */}
            </div>
            <div className="publish-modal-meta">
              Live · published {publication.publishedAt
                ? new Date(publication.publishedAt).toLocaleString()
                : "just now"}
            </div>

            {isSigninMode && (
              <div className="publish-modal-helper">
                This publication is sign-in restricted. Pick Open or Password to manage it from the UI.
              </div>
            )}

            <div className="publish-modal-section-label">Access</div>
          </>
        )}

        <div className="publish-modal-modes">
          <label className={`publish-modal-mode${mode === "open" ? " publish-modal-mode--selected" : ""}`}>
            <input type="radio" name="publish-mode" value="open" checked={mode === "open"} onChange={() => handleModeChange("open")} style={{ display: "none" }} />
            <span className="publish-modal-mode__radio" />
            <span><strong>Open</strong> · <span style={{ color: "#94a3b8" }}>anyone with the link</span></span>
          </label>
          <label className={`publish-modal-mode${mode === "password" ? " publish-modal-mode--selected" : ""}`}>
            <input type="radio" name="publish-mode" value="password" checked={mode === "password"} onChange={() => handleModeChange("password")} style={{ display: "none" }} />
            <span className="publish-modal-mode__radio" />
            <span><strong>Password</strong> · <span style={{ color: "#94a3b8" }}>link + password</span></span>
          </label>
        </div>

        {mode === "password" && (
          <input
            type="password"
            className="publish-modal-password"
            placeholder={
              isPublished && publication?.shareMode === "password"
                ? "Password is set. Leave blank to keep it."
                : "Enter a password"
            }
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        )}

        <div className={`publish-modal-actions${isPublished ? " publish-modal-actions--published" : ""}`}>
          {isPublished ? (
            <>
              <button type="button" className="publish-modal-btn publish-modal-btn--unpublish" onClick={() => setConfirmUnpublish(true)} disabled={phase !== "idle"}>
                {phase === "unpublishing" ? "Unpublishing…" : "Unpublish"}
              </button>
              <div style={{ display: "flex", gap: 8 }}>
                {canSave && (
                  <button type="button" className="publish-modal-btn publish-modal-btn--primary" onClick={handleSave} disabled={!canSave}>
                    {phase === "publishing" ? "Saving…" : "Save"}
                  </button>
                )}
                <button type="button" className="publish-modal-btn" onClick={onClose} disabled={phase !== "idle"}>Done</button>
              </div>
            </>
          ) : (
            <>
              <button type="button" className="publish-modal-btn publish-modal-btn--cancel" onClick={onClose} disabled={phase !== "idle"}>Cancel</button>
              <button type="button" className="publish-modal-btn publish-modal-btn--primary" onClick={handlePublish} disabled={!canPublish}>
                {phase === "publishing" ? "Publishing…" : "Publish"}
              </button>
            </>
          )}
        </div>

        <ConfirmModal
          open={confirmUnpublish}
          title="Unpublish this artefact?"
          body="This retires the URL — re-publishing creates a new one."
          confirmLabel="Unpublish"
          destructive
          onConfirm={handleUnpublish}
          onCancel={() => setConfirmUnpublish(false)}
        />
```

- [ ] **Step 3: Update the eyebrow text and title for the published state**

Change the eyebrow line:

```tsx
<div className="publish-modal-eyebrow">{isPublished ? "Published" : "Publish artefact"}</div>
```

- [ ] **Step 4: Build**

```bash
cd web && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add web/src/components/PublishModal.tsx web/src/components/PublishModal.css
git commit -m "feat(317): PublishModal published state with mode picker, save, unpublish"
```

---

### Task 13: Add QR toggle (lazy-loaded)

**Files:**
- Modify: `web/src/components/PublishModal.tsx`

**Why:** Spec calls for the QR module to load via dynamic `import()` only on first toggle so it doesn't hit the initial bundle.

- [ ] **Step 1: Add a lazy-loaded QR renderer**

Inside `PublishModal.tsx`, after the existing `useState` blocks:

```tsx
const [qrSvg, setQrSvg] = useState<string | null>(null);

useEffect(() => {
  if (!showQr || !publication?.shareUrl) {
    setQrSvg(null);
    return;
  }
  let cancelled = false;
  (async () => {
    const { default: qrcode } = await import("qrcode-generator");
    if (cancelled) return;
    // type 0 = auto type-number, 'M' = medium error correction.
    const q = qrcode(0, "M");
    q.addData(publication.shareUrl);
    q.make();
    // size:4 = 4-pixel module size; margin:0 = no quiet-zone in the SVG (we
    // pad with the surrounding container).
    setQrSvg(q.createSvgTag({ scalable: true, margin: 0 }));
  })();
  return () => { cancelled = true; };
}, [showQr, publication?.shareUrl]);
```

- [ ] **Step 2: Render the SVG when toggled**

In the JSX, after the `</div>` of `publish-modal-url__actions` and before the closing `</div>` of `publish-modal-url`:

```tsx
{showQr && qrSvg && (
  <div
    style={{
      marginTop: 14,
      display: "flex",
      justifyContent: "center",
      background: "#fff",
      borderRadius: 6,
      padding: 12,
    }}
    dangerouslySetInnerHTML={{ __html: qrSvg }}
  />
)}
{showQr && !qrSvg && (
  <div style={{ marginTop: 14, textAlign: "center", fontSize: 11, color: "#64748b" }}>
    Generating QR…
  </div>
)}
```

- [ ] **Step 3: Add `qrcode-generator` types if missing**

```bash
cd web && npm i -D @types/qrcode-generator
```

If `@types/qrcode-generator` doesn't exist, add a 5-line module declaration in `web/src/globals.d.ts`:

```ts
declare module "qrcode-generator" {
  interface Qr {
    addData(data: string): void;
    make(): void;
    createSvgTag(opts?: { scalable?: boolean; margin?: number }): string;
  }
  function qrcode(typeNumber: number, errorCorrectionLevel: "L" | "M" | "Q" | "H"): Qr;
  export default qrcode;
}
```

- [ ] **Step 4: Build**

```bash
cd web && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add web/src/components/PublishModal.tsx web/package.json web/package-lock.json web/src/globals.d.ts
git commit -m "feat(317): lazy-loaded QR toggle in PublishModal"
```

---

### Task 14: Add the signed-out state and sign-in flow to `PublishModal`

**Files:**
- Modify: `web/src/components/PublishModal.tsx`

**Why:** A signed-out user clicking Publish needs to be led through Oyster sign-in (the same device flow AuthBadge uses) without losing the modal context.

- [ ] **Step 1: Add the auth state**

Inside `PublishModal.tsx`:

```tsx
import { subscribeUiEvents } from "../data/ui-events";
```

Add state:

```tsx
type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signing-in"; signInUrl: string; expiresAt: number }
  | { status: "signed-in"; email: string };

const [auth, setAuth] = useState<AuthState>({ status: "loading" });
```

- [ ] **Step 2: Fetch whoami on open + subscribe to auth_changed**

```tsx
useEffect(() => {
  if (!artifact) return;
  let cancelled = false;
  const refresh = async () => {
    try {
      const res = await fetch("/api/auth/whoami");
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { user: { email: string } | null };
      if (cancelled) return;
      setAuth(body.user ? { status: "signed-in", email: body.user.email } : { status: "signed-out" });
    } catch {
      if (cancelled) return;
      setAuth({ status: "signed-out" });
    }
  };
  refresh();
  const unsub = subscribeUiEvents((e) => {
    if (e.command === "auth_changed") refresh();
  });
  return () => { cancelled = true; unsub(); };
}, [artifact?.id]);
```

- [ ] **Step 3: Sign-in handler + polling fallback**

```tsx
async function handleSignIn() {
  setError(null);
  try {
    const res = await fetch("/api/auth/login", { method: "POST" });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { sign_in_url: string; expires_in: number };
    window.open(body.sign_in_url, "_blank", "noopener,noreferrer");
    setAuth({
      status: "signing-in",
      signInUrl: body.sign_in_url,
      expiresAt: Date.now() + body.expires_in * 1000,
    });
  } catch (err) {
    setError("Couldn't start sign-in — try again.");
  }
}

useEffect(() => {
  if (auth.status !== "signing-in") return;
  let cancelled = false;
  const tick = async () => {
    if (cancelled) return;
    try {
      const res = await fetch("/api/auth/whoami");
      if (!res.ok) return;
      const body = (await res.json()) as { user: { email: string } | null };
      if (cancelled) return;
      if (body.user) {
        setAuth({ status: "signed-in", email: body.user.email });
      } else if (Date.now() > auth.expiresAt) {
        setAuth({ status: "signed-out" });
      }
    } catch {
      // network blip; next tick will retry
    }
  };
  const interval = setInterval(tick, 3000);
  return () => { cancelled = true; clearInterval(interval); };
}, [auth.status, auth.status === "signing-in" ? auth.expiresAt : 0]);
```

- [ ] **Step 4: Render the signed-out / signing-in branch**

Before the existing `{error && …}` block, add:

```tsx
{auth.status !== "signed-in" && auth.status !== "loading" && (
  <>
    <div className="publish-modal-helper">
      Sign in to Oyster to publish.<br />
      Publishing requires an account.
    </div>
    <div className="publish-modal-actions">
      <button type="button" className="publish-modal-btn publish-modal-btn--cancel" onClick={onClose}>
        Cancel
      </button>
      {auth.status === "signing-in" ? (
        <button type="button" className="publish-modal-btn" onClick={() => setAuth({ status: "signed-out" })}>
          Cancel sign-in
        </button>
      ) : (
        <button type="button" className="publish-modal-btn publish-modal-btn--primary" onClick={handleSignIn}>
          Sign in
        </button>
      )}
    </div>
    {auth.status === "signing-in" && (
      <div className="publish-modal-meta" style={{ marginTop: 14 }}>
        Sign-in opened in a new tab — return here when done.
      </div>
    )}
  </>
)}
```

Then wrap the existing publish/published JSX so it only renders when signed in:

```tsx
{auth.status === "signed-in" && (
  <>
    {/* the existing error/published/picker/actions JSX */}
  </>
)}
```

- [ ] **Step 5: Build**

```bash
cd web && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add web/src/components/PublishModal.tsx
git commit -m "feat(317): PublishModal signed-out flow with device-flow sign-in"
```

---

## Phase 6 — Wiring

### Task 15: Mount `PublishModal` in `App.tsx` and add the SSE listener

**Files:**
- Modify: `web/src/App.tsx`

**Why:** Single PublishModal instance lives at the App-shell level, alongside the existing modals (`InspectorPanel`, etc). State (`publishingArtifact`) is held here. SSE `artifact_changed` triggers an artefact list refetch so chips and modal state stay live.

- [ ] **Step 1: Add state for the publish-target artefact**

Near the other modal state:

```tsx
const [publishingArtifact, setPublishingArtifact] = useState<Artifact | null>(null);
```

- [ ] **Step 2: Subscribe to `artifact_changed`**

In the existing SSE subscription `useEffect` (around line 187, where `subscribeUiEvents` is set up), add a branch:

```tsx
if (event.command === "artifact_changed") {
  void fetchArtifacts().then(setArtifacts);
  // The opener also re-syncs the open modal's view of `artifact.publication`
  // through the artefacts state lookup below.
  return;
}
```

If the modal is open and the SSE event matches its target, re-bind the modal's artefact prop so the published state refreshes. Inside the JSX where the modal mounts, derive the freshest artefact:

```tsx
{publishingArtifact && (() => {
  const fresh = artifacts.find((a) => a.id === publishingArtifact.id) ?? publishingArtifact;
  return <PublishModal artifact={fresh} onClose={() => setPublishingArtifact(null)} />;
})()}
```

- [ ] **Step 3: Add an opener function**

```tsx
const handleArtifactPublish = useCallback((artifact: Artifact) => {
  // UI gating — backend still works for everything else, but the UI hides Publish.
  if (artifact.builtin || artifact.plugin || artifact.status === "generating") return;
  setPublishingArtifact(artifact);
}, []);
```

- [ ] **Step 4: Build**

```bash
cd web && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat(317): mount PublishModal in App with artifact_changed SSE listener"
```

---

### Task 16: Add Publish entry to the Desktop context menu

**Files:**
- Modify: `web/src/components/Desktop.tsx`
- Modify: `web/src/App.tsx` (pass the opener through)

**Why:** Right-click → Publish… is the primary entry point. Hidden for builtin / plugin / generating artefacts and in the archived view.

- [ ] **Step 1: Thread the opener prop through Desktop**

In `Desktop.tsx`, add to `Props`:

```tsx
onArtifactPublish?: (artifact: Artifact) => void;
```

In the function signature, destructure it. In the artefact context menu JSX (around lines 268-292), after "Regenerate icon" and before the `space-ctx-sep` separator:

```tsx
{!isArchivedView && !artifactCtx.artifact.builtin && !artifactCtx.artifact.plugin && artifactCtx.artifact.status !== "generating" && onArtifactPublish && (
  <button
    className="space-ctx-item"
    onClick={() => {
      const a = artifactCtx.artifact;
      setArtifactCtx(null);
      onArtifactPublish(a);
    }}
  >
    {artifactCtx.artifact.publication?.unpublishedAt === null ? "Manage publication…" : "Publish…"}
  </button>
)}
```

- [ ] **Step 2: Wire the prop in `App.tsx`**

Find each `<Desktop ...>` invocation and add:

```tsx
onArtifactPublish={handleArtifactPublish}
```

- [ ] **Step 3: Build**

```bash
cd web && npm run build
```

- [ ] **Step 4: Manual smoke**

```bash
npm run dev
```

Right-click an artefact in the surface. The "Publish…" entry should appear. Click — modal opens. Pick Open → Publish. Modal closes. Tile shows the chip. Right-click again — "Manage publication…" entry now appears. Click — published-state modal renders with the URL.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/Desktop.tsx web/src/App.tsx
git commit -m "feat(317): add Publish entry to artefact context menu"
```

---

### Task 17: Add a Share button to the ViewerWindow header

**Files:**
- Modify: `web/src/components/ViewerWindow.tsx`
- Modify: `web/src/components/WindowChrome.tsx`
- Modify: `web/src/App.tsx`

**Why:** When a user is viewing an artefact in the file viewer, putting Publish in the chrome header makes it discoverable without context-menu hunting.

- [ ] **Step 1: Add an `extraHeader` slot to `WindowChrome`**

In `WindowChrome.tsx`, add to `Props`:

```tsx
extraHeader?: React.ReactNode;
```

In the title-bar JSX (the section that renders the existing window controls), insert `{extraHeader}` just before the close/fullscreen buttons.

- [ ] **Step 2: Add `onShare` and `shareDisabled` props to `ViewerWindow`**

```tsx
interface Props {
  // …existing…
  onShare?: () => void;
  shareDisabled?: boolean;
  shareLabel?: "Publish" | "Published";  // tints the button purple when "Published"
}
```

In the JSX, render the Share button as `extraHeader`:

```tsx
import { Share2 } from "lucide-react";

const shareButton = onShare && !shareDisabled ? (
  <button
    type="button"
    className="window-btn"
    onClick={(e) => { e.stopPropagation(); onShare(); }}
    title={shareLabel === "Published" ? "Manage publication" : "Publish"}
    style={shareLabel === "Published" ? { color: "#a78bfa" } : undefined}
  >
    <Share2 size={14} strokeWidth={2} />
  </button>
) : null;
```

Pass it down: `<WindowChrome ... extraHeader={shareButton}>`.

- [ ] **Step 3: Wire the props from `App.tsx`**

Where `<ViewerWindow>` mounts (around line 429), look up the artefact:

```tsx
const viewerArtifact = docArtifacts[currentIdx];
```

Pass:

```tsx
onShare={viewerArtifact ? () => handleArtifactPublish(viewerArtifact) : undefined}
shareDisabled={!viewerArtifact || viewerArtifact.builtin || viewerArtifact.plugin || viewerArtifact.status === "generating"}
shareLabel={viewerArtifact?.publication?.unpublishedAt === null ? "Published" : "Publish"}
```

- [ ] **Step 4: Build**

```bash
cd web && npm run build
```

- [ ] **Step 5: Manual smoke**

Open an artefact via single-click. The viewer window's header should show a small share icon. Click — publish modal opens for that artefact.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/ViewerWindow.tsx web/src/components/WindowChrome.tsx web/src/App.tsx
git commit -m "feat(317): add Share button to ViewerWindow header"
```

---

### Task 18: Add `/p` slash command to ChatBar

**Files:**
- Modify: `web/src/components/ChatBar.tsx`
- Modify: `web/src/App.tsx`

**Why:** Mirrors `/o` exactly. `/p competitor` → publish modal opens for the matched artefact. Builtin / plugin / generating filtered out before scoring.

- [ ] **Step 1: Add the slash entry**

In `ChatBar.tsx`, add to `SLASH_COMMANDS`:

```tsx
{ cmd: "/p", args: "<artefact>", desc: "Publish artifact", example: "/p competitor analysis" },
```

- [ ] **Step 2: Add the new prop**

```tsx
onArtifactPublish?: (artifact: Artifact) => void;
```

In the function destructure, add it. In the `Props` interface, define it.

- [ ] **Step 3: Filter publishable artefacts and add `/p` scoring branch**

Above `slashItems`'s `useMemo`:

```tsx
const publishableArtifacts = useMemo(
  () => artifacts.filter((a) => !a.builtin && !a.plugin && a.status !== "generating"),
  [artifacts],
);
```

In the `slashItems` body, after the `/o` branch:

```tsx
const publishArgMatch = lower.match(/^\/p(\s+(.*))?$/);
if (publishArgMatch !== null && (lower === "/p" || lower.startsWith("/p "))) {
  const q = (publishArgMatch[2] || "").trim();
  if (!q) {
    return publishableArtifacts.slice(0, 8).map(a => ({ key: a.id, label: a.label, desc: a.spaceId, type: "artifact" as const, score: 0 }));
  }
  // Reuse the existing scorer but against the filtered set.
  const scoredAll = scoreArtifacts(q);
  const allowed = new Set(publishableArtifacts.map((a) => a.id));
  return scoredAll.filter(({ a }) => allowed.has(a.id))
    .slice(0, 8)
    .map(x => ({ key: x.a.id, label: x.a.label, desc: x.a.spaceId, type: "artifact" as const, score: x.score }));
}
```

In `handleSend`, after the `cmd === 'o'` branch:

```tsx
if (cmd === "p" && onArtifactPublish) {
  const allowed = new Set(publishableArtifacts.map((a) => a.id));
  const scored = scoreArtifacts(q).filter(({ a }) => allowed.has(a.id));
  if (scored.length === 0) {
    setMessages(prev => [...prev, { role: "assistant", content: `No artifact matching "${arg.trim()}"` }]);
    setExpanded(true);
  } else if (scored.length === 1 || scored[0].score >= scored[1].score * 2) {
    onArtifactPublish(scored[0].a);
  } else {
    setInput(`/p ${arg.trim()}`);
    return;
  }
}
```

In the slash-autocomplete click handlers and Enter handlers (where the existing artifact-type items call `onArtifactOpen`), add a sibling branch: if the input was prefixed `/p`, route to `onArtifactPublish` instead. Since the existing pattern is type-based not prefix-based, the easier route is: keep the autocomplete dropdown's click behaviour as "complete the input"; let the user press Enter to execute. The Enter branch already exists; just route by `input.startsWith("/p")`.

A simpler refactor: in `slashItems`, when building `/p` items, give them `type: "publish-artifact" as const`. Then in click handlers and the Enter handler, add a case for that type.

```tsx
if (item.type === "publish-artifact") {
  setInput("");
  const a = artifacts.find(x => x.id === item.key);
  if (a) onArtifactPublish?.(a);
}
```

- [ ] **Step 4: Wire the prop in `App.tsx`**

In the `<ChatBar ... />` invocation:

```tsx
onArtifactPublish={handleArtifactPublish}
```

- [ ] **Step 5: Build**

```bash
cd web && npm run build
```

- [ ] **Step 6: Manual smoke**

In the dev server, type `/p` in the chat bar. Autocomplete shows artefacts (no plugins). Type `/p <name>` and press Enter — publish modal opens for the matched artefact.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/ChatBar.tsx web/src/App.tsx
git commit -m "feat(317): add /p slash command for publish"
```

---

## Phase 7 — Polish

### Task 19: Add CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

**Why:** Per project conventions, every user-visible change ships its CHANGELOG bullet in the same PR.

- [ ] **Step 1: Read the changelog format**

```bash
head -30 CHANGELOG.md
```

- [ ] **Step 2: Add an Added bullet under the unreleased section**

Insert under the existing `## Unreleased` header (or whichever section is appropriate) under `### Added`:

```markdown
- **Publish artefacts from the surface.** Right-click any artefact for a Publish entry, or use the Share button in the file viewer, or type `/p <artefact>` in the chat bar. Modal supports Open and Password modes; published tiles show a small chip with one-click copy. QR toggle for mobile handoff.
```

- [ ] **Step 3: Regenerate the changelog HTML**

```bash
npm run build:changelog
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md docs/changelog.html
git commit -m "docs(317): changelog entry for publish UI"
```

---

### Task 20: Final manual smoke against deployed Worker

**Files:** None — verification only.

**Why:** Backend is in production. The UI talks to it via the local server proxy. Smoke must hit the real Worker so we catch any wire-format / SSE drift.

- [ ] **Step 1: Start dev server**

```bash
cd ~/Dev/oyster-os.worktrees/317-publish-ui && npm run dev
```

- [ ] **Step 2: Run through the full happy-path matrix**

Tick each off as you confirm:

- Right-click a notes artefact → Publish… → pick Open → click Publish → modal flips to published state with URL.
- Click Copy link → button shows "Copied". Paste into a fresh incognito window — content renders.
- Click the QR icon → SVG renders. Phone-camera-scan works (optional).
- Click Done. Tile now shows the "Published" chip. Click the chip's icon — clipboard contains URL; chip flashes ✓.
- Right-click → Manage publication… → switch to Password → enter "test123" → Save appears → click Save → modal updates. Visit URL — password gate enforced.
- Inside the published-state modal, click Unpublish → confirm overlay shows the warning text → confirm. Modal returns to unpublished state. Visit URL — 410 Gone.
- Open an artefact in the viewer (click the tile). Click the Share icon in the header — modal opens.
- Type `/p <substring>` in the chat bar — autocomplete shows publishable artefacts only (no plugins).
- Right-click on a builtin / plugin / generating-state artefact — no Publish entry appears.
- Sign out via AuthBadge. Right-click an artefact → Publish → modal shows sign-in CTA. Click Sign in — new tab opens. Sign in there. Modal updates to the unpublished state and the user can click Publish.

- [ ] **Step 3: Watch the SSE stream during a publish**

In a separate terminal:

```bash
curl -N http://localhost:3333/api/ui/events
```

Trigger a publish from the UI. Confirm the stream emits `{"command":"artifact_changed","payload":{"id":"…"}}` immediately after.

- [ ] **Step 4: If any case fails, file an inline fix-up commit**

Don't ship if any case fails. Each fix-up is its own commit on the same branch.

---

## Open question deferred to implementation

**Password rotation cookie invalidation.** Per the spec self-review, it's unclear whether changing `share_password_hash` on a publication invalidates the existing visitor unlock cookies. The cookie is HMAC'd against `share_token` plus a timestamp, not the password hash, so a hash change may not by itself force re-entry.

**Action:** During Task 12 ("password-only update" path), verify the viewer cookie-verify flow in `infra/oyster-publish/src/viewer-cookie.ts`. If existing cookies remain valid after a hash change, either (a) accept and document in CHANGELOG, or (b) extend the cookie payload to embed the password-hash version. Decision depends on what reviewer prefers.

---

## Self-review checklist

After all tasks are complete:

- [ ] Spec coverage — every Goal in the spec maps to at least one task.
- [ ] No placeholders (`TBD`, `TODO`, "implement later") left in any modified file.
- [ ] Type consistency — `ArtefactPublication` shape used identically across `shared/types.ts`, `publish-api.ts`, `PublishedChip.tsx`, `PublishModal.tsx`.
- [ ] CHANGELOG entry added.
- [ ] All commits pass `npm run build` (server + web) and `npm test` (server).
- [ ] PR description references this plan and the spec.

---

## Anchor docs

- [Spec — `2026-05-04-r5-publish-ui-design.md`](../specs/2026-05-04-r5-publish-ui-design.md)
- [Backend spec — `2026-05-03-r5-publish-backend-design.md`](../specs/2026-05-03-r5-publish-backend-design.md)
- [Viewer spec — `2026-05-03-r5-viewer-design.md`](../specs/2026-05-03-r5-viewer-design.md)
- Issue #317
