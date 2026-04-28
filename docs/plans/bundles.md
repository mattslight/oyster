# Multi-file static artefacts ("bundles") — Design Notes

> **Status (2026-04-28):** Proposed. Triggered by the tokinvest portfolio-redesign prototype incident, which surfaced a real gap: an agent can register a single file or a process, but not "this folder of HTML/CSS/JS as one artefact." Targets the **0.6.0** milestone — no implementation in flight yet.

## Core Insight

**Today's artefact taxonomy has a hole in the middle.**

| Need | Today |
|---|---|
| External link (e.g. a Figma URL) | ✅ `runtime_kind = 'redirect'` |
| Single document (`.md`, `.html`, single-file SPA) | ✅ `runtime_kind = 'static_file'`, served at `/docs/<id>` |
| **Multi-file static thing** (a `vite build` output, Storybook export, clickable demo) | ❌ **missing** |
| Local-runnable app (needs `npm run dev`) | ⚠️ `runtime_kind = 'local_process'` exists, but can't be set via MCP — see [Out of scope § `local_process` MCP gap](#out-of-scope) |

A folder of HTML/CSS/JS *can be moved onto disk* under `~/Oyster/spaces/<space>/`, but Oyster has no concept of "this folder is one logical artefact." Today's only way to register multi-file content is to register *one* file inside the folder via `register_artifact` — which serves only that file at `/docs/<id>`. Sibling files are unreachable through any registered artefact URL. This is the wall the tokinvest prototype hit: `index.html` was registered, the meta-refresh to `portfolio.html` resolved to `/docs/portfolio.html` (a different, non-existent artefact id), 404.

The fix is to introduce a **multi-file static artefact** as a new `runtime_kind`, served at a registry-keyed URL (`/a/<artefact-id>/*`) that reuses the existing static-file serving primitives, and a new MCP tool that lets agents *ship bytes* (rather than register a server-side filesystem path) — so the same primitive works locally and in cloud.

## Why this matters beyond the immediate gap

Three things ride on this single change:

1. **Multi-file prototypes work.** The most common artefact an agent produces today (a clickable HTML demo with sibling files) becomes registerable in one MCP call.
2. **Cloud Oyster becomes feasible.** Today's `register_artifact` requires a server-readable filesystem path — only works because agent and server share a laptop. The new `push_artifact` ships bytes through the MCP channel itself; identical signature whether the server is `localhost:4444` or `oyster.to`. Same primitive, two storage backends.
3. **Sharing-with-others becomes a thin layer on top.** Once artefacts are registry-keyed at `/a/<id>/*`, a shared route at `/p/<token>/*` reuses the same registry-aware serving logic behind a different auth gate. ~1 day of work *after* this lands. See "Forward compatibility" below.

This is the foundational change that unlocks the next two arcs (cloud + sharing). It is not a plugin runtime, it is not a runtime-process change, it is not a sharing feature — it is the *primitive* those things sit on.

## Naming — and why not just call it "bundle"

The word **bundle** is already taken in the plugin/app system (see [apps-system.md](./apps-system.md) line 30): `runtime: "bundle"` means an *esbuild-output JS plugin* that runs in a sandboxed iframe and talks to the host via `postMessage`. That's a distinct future concern with its own SDK and capabilities model.

This doc proposes **`runtime_kind: 'static_dir'`** for the new artefact runtime — parallel to the existing `static_file`, distinct from the plugin world's `bundle`. In prose we may informally say "bundle artefact" (because "a bundle of files" is intuitive English), but the schema name is `static_dir` to avoid the collision.

| Domain | Term | Meaning |
|---|---|---|
| Plugins (apps-system.md) | `runtime: "static"` | Folder of HTML, served as iframe artifact (e.g. zombie-horde) |
| Plugins (apps-system.md) | `runtime: "bundle"` *(future)* | esbuild JS, sandboxed iframe + SDK + postMessage |
| Artefacts (this doc) | `runtime_kind: 'static_file'` | Single file, served at `/docs/<id>` |
| Artefacts (this doc) | `runtime_kind: 'static_dir'` *(new)* | Directory, served at `/a/<artefact-id>/*` |

Plugin `runtime: "static"` and artefact `runtime_kind: 'static_dir'` are structurally similar (both are folders served as iframes). They share the lowest serving primitives (MIME types, path-traversal guards, directory-index handling) but live behind different routes — plugins at `/artifacts/<relativePath>` (path-keyed, today), artefacts at `/a/<id>/*` (registry-keyed, new). The metadata layer differs (plugins have a manifest; artefacts have a DB row) and that's fine.

## Ownership model — two patterns, agent picks

This is the part that took several conversational iterations to surface, so it's spelled out explicitly before the schema. **Multi-file artefacts come in two flavours**, distinguished by *who owns the bytes*. Both are first-class. Picking the right one per artefact eliminates the sync problem entirely.

### Pattern A — Managed bundle (Oyster-owned, MCP-mutable)

```
agent ─push_artifact─▶ Oyster
                        ├─ writes bytes under SPACES_DIR/<space>/<id>/  (local)
                        └─ writes bytes to s3://tenant/<id>/             (cloud)

agent ─update_file_in_artifact─▶ Oyster mutates the file
agent ─delete_file_in_artifact─▶ Oyster deletes the file
agent ─push_artifact (same id)─▶ Oyster atomically replaces the bundle
```

- **Source of truth:** Oyster.
- **Edits:** via MCP only. The agent reads via `list_artifact_files` + `read_artifact`, edits via `update_file_in_artifact`, deletes via `delete_file_in_artifact`, full-replaces via `push_artifact`. Never via shell.
- **Works:** locally and in cloud (cross-environment).
- **Use when:** the agent *generates* content (a prototype, a synthesised demo, an export). There's no other home for the bytes — Oyster is the home.
- **Schema:** `storage_kind = 'filesystem'` (or `'object_store'` in cloud), `runtime_kind = 'static_dir'`, `ownership = 'managed'`.

### Pattern B — Linked directory (externally-owned, read-only-in-place)

```
agent ─Edit/Write/shell─▶ ~/Dev/some-project/dist/  (externally edited)
                                  │
                                  └── Oyster reads in real-time at request time
                                      (registered with register_artifact)
```

- **Source of truth:** the external directory. Whatever puts files there (the user's editor, `vite build --watch`, the agent's shell tools, a sync tool, anything).
- **Edits:** outside Oyster, at the original path. Oyster doesn't mutate.
- **Works:** local install only — cloud Oyster has no shared filesystem to link against.
- **Use when:** the user (or an agent with shell access) is *actively iterating* on a folder elsewhere — a dev repo, a build output, a working directory — and just wants Oyster to surface it. No copy, no sync, edits show up on next refresh.
- **Schema:** `storage_kind = 'filesystem'`, `runtime_kind = 'static_dir'`, `ownership = 'linked'`. Created via an extended `register_artifact(path: <directory>, runtime_kind: 'static_dir')`.

### Why this is *not* a sync problem

The sync problem only arises if **the same artefact has two writeable copies** (managed *and* externally-edited at the same time). The schema prevents that — and the field that prevents it is `ownership`, *not* `storage_kind` (those are orthogonal concerns; see "Schema" below):

- `ownership='managed'`: writes go through MCP. Shell-edits to the bundle directory are *possible* (it's just a folder on disk locally) but the convention is "don't" — the directory is Oyster-owned. Cloud version makes this explicit because the bundle isn't on the user's filesystem at all.
- `ownership='linked'`: MCP edit tools (`update_file_in_artifact` etc.) *refuse to operate*. Edits go to the external path and Oyster reads them on next request. There's only ever one canonical copy.

So at any given moment, *one* writer owns *one* canonical copy of the bytes. No reconciliation, no merge, no conflicts.

### Picking a pattern

| Situation | Pattern |
|---|---|
| Agent just generated a one-off prototype to demo | A (managed — push it) |
| User has a `vite build --watch` going on a dev repo, wants Oyster to surface the latest `dist/` | B (linked — register the path) |
| Cloud Oyster, anything | A (B doesn't exist in cloud) |
| Agent is iterating rapidly with shell tools on a folder it just `git clone`d | B locally; A cross-env |
| User points Oyster at their `~/Documents/notes/` folder | B |

In short: **Pattern A when bytes are born in the agent's MCP session, Pattern B when bytes are born somewhere else.**

### How an agent picks

The agent's choice is determined by where the content already lives:

- *I just wrote these files into my own working directory and there's no expectation Oyster sees that directory* → **Pattern A (push)**. Bytes are copied into Oyster; agent's working copy is throwaway. After push, all further edits go through MCP.
- *These files live somewhere the user controls (a dev repo, a known folder) and they'll keep being edited there* → **Pattern B (register)**. Oyster just gets a pointer.
- *I don't know which to pick* → **Pattern A is the safer default**. Picks up no external dependency on a path that might move; works in cloud unchanged.

In Claude Code today: the agent's "working copy" is wherever it ran `Edit`/`Write`. After `push_artifact`, that working copy can be deleted — Oyster has the canonical bytes. If the agent needs to iterate, it reads from Oyster (`list_artifact_files`, `read_artifact`), edits via MCP (`update_file_in_artifact`), and never re-establishes a local working copy. This is the cloud-portable flow.

## Design

### Storage

Multi-file artefacts live as plain directories under the space's native folder:

```
~/Oyster/spaces/tokinvest/
├── invoices/                         ← user-organising folder, NOT a registered artefact
│   ├── MS-2026-001.html              ← single-file artefact (runtime_kind=static_file)
│   └── MS-2026-002.html              ← single-file artefact
├── portfolio-redesign/               ← multi-file artefact (runtime_kind=static_dir)
│   ├── index.html                    ← entry
│   ├── portfolio.html
│   └── assets/
│       └── styles.css
└── notes-on-positioning.md           ← single-file artefact at space root
```

The disk layout doesn't tell you what's a registered artefact and what isn't — **the DB row's `runtime_kind` does.** A folder like `invoices/` happens to contain registered single-file artefacts; it isn't itself registered. A folder like `portfolio-redesign/` *is* registered (as `runtime_kind=static_dir`), so it's a logical unit.

DB row shape — **three orthogonal axes** that can vary independently:

| Axis | Values | Question it answers |
|---|---|---|
| `storage_kind` | `filesystem` \| `object_store` \| `url` | *Where* do the bytes live? |
| `runtime_kind` | `static_file` \| `static_dir` \| `local_process` \| `redirect` | *How* are they served? |
| `ownership` *(NEW column)* | `managed` \| `linked` | *Who* gets to edit? |

Keeping these separate keeps the model clean as cloud storage, sharing, and local folders all coexist. `managed` is an ownership policy, not a storage type. Examples:

**Pattern A — Agent-pushed prototype (managed, local install):**
```
storage_kind:    filesystem
storage_config:  {"path": "<SPACES_DIR>/tokinvest/portfolio-redesign"}
runtime_kind:    static_dir
runtime_config:  {"entry": "index.html"}
ownership:       managed
source_origin:   ai_generated
```

**Pattern B — Linked dev folder (linked, local install):**
```
storage_kind:    filesystem
storage_config:  {"path": "/Users/me/Dev/tokinvest-concept/dist"}
runtime_kind:    static_dir
runtime_config:  {"entry": "index.html"}
ownership:       linked
source_origin:   manual
```

**Future — Cloud-pushed prototype (managed, cloud install):**
```
storage_kind:    object_store
storage_config:  {"bucket": "oyster-tenant-acme", "prefix": "spaces/tokinvest/portfolio-redesign"}
runtime_kind:    static_dir
runtime_config:  {"entry": "index.html"}
ownership:       managed
source_origin:   ai_generated
```

The `runtime_kind` is the same across all three — the *serving* logic doesn't care where bytes live or who can mutate them. The `ownership` column is what gates MCP edit tools:

- `ownership='managed'` → MCP edit tools work.
- `ownership='linked'` → MCP edit tools refuse; edits go to the external path.

Existing single-file artefacts default to `ownership='linked'` for safety (no MCP mutation of pre-existing rows). New rows created via `push_artifact` set `ownership='managed'`. Backfilling existing `create_artifact`-written rows under SPACES_DIR to `managed` is a future cleanup that doesn't block this work.

### Serving — `/a/<artifact-id>/*` (registry-aware route)

Multi-file artefacts are served at a **registry-keyed** URL, not a path-keyed one:

- `/a/portfolio-redesign/` → entry file (default `index.html`) *(directory index)*
- `/a/portfolio-redesign/portfolio.html` → that file
- `/a/portfolio-redesign/assets/styles.css` → that file

**Why registry-keyed and not `/artifacts/spaces/<space>/<id>/...`:** the existing `/artifacts/<relativePath>` resolver leaks the storage layout into the URL. That makes:

- *Permissions / archive checks awkward* — the URL doesn't go through a row lookup, so you can't easily gate it on `archived_at IS NULL`, `space_id`, or future share state.
- *Cloud awkward* — when storage moves to `object_store`, the URL would have to change to leak a different path shape, breaking links.
- *Sharing awkward* — share URLs (`/p/<token>/*`) want the same shape as the owner URL but with a different identifier; registry-keyed gives that uniformly.

The `/a/<id>/*` handler is a thin registry-aware wrapper:

```
1. Look up artefact_id in DB.
2. Reject if not found, archived, or runtime_kind != 'static_dir'.
3. Read storage_kind + storage_config to figure out where the bytes are.
4. Resolve the sub-path (with `..`-traversal protection).
5. Serve via shared static-file logic (MIME, directory-index, etc.).
```

**Implementation reuses the existing serving primitives.** The MIME table, the markdown/mermaid renderers, the path-traversal guard, the bridge injection — all in `resolveArtifactsUrl` and its caller — are factored out so `/a/<id>/*` and the existing `/artifacts/<relativePath>` route share the lowest layer. The two routes coexist; `/artifacts/...` keeps serving icons and plugin "static" content unchanged.

The artefact's `url` field (returned by the API and used by the web app's iframe) is set by `rowToArtifact` in `artifact-service.ts`:

```ts
url = row.runtime_kind === 'static_dir'
  ? `/a/${row.id}/`           // trailing slash → relative links inside resolve correctly
  : `/docs/${row.id}`;        // unchanged for static_file
```

The frontend already opens `artifact.url` in an iframe — no web change required.

**Storage-backend dispatch** (future cloud): inside `/a/<id>/*`, after the registry lookup, dispatch on `storage_kind`:

```ts
if (storage_kind === 'filesystem')   → read from storage_config.path + sub-path
if (storage_kind === 'object_store') → S3 GetObject(bucket, prefix + sub-path)
```

Single chokepoint; everything else (MIME, errors, headers) is shared.

### MCP — `push_artifact`

The cloud-relevant piece. Today's `register_artifact` takes a server-readable filesystem path; that only works because the agent and server happen to share a filesystem. `push_artifact` takes the actual bytes.

```js
push_artifact({
  space_id: "tokinvest",
  label: "Portfolio Redesign",
  artifact_kind: "app",                   // optional, inferred if omitted
  files: [
    { path: "index.html",        content: "<!DOCTYPE html>..." },
    { path: "portfolio.html",    content: "..." },
    { path: "assets/styles.css", content: "..." },
  ],
  group_name: "Prototypes",               // optional
  id: "portfolio-redesign",               // optional, slugified from label if omitted
})
```

Server behaviour:

1. Validate (`space_id` exists; `files[].path` are relative, no `..`, no absolute paths; non-empty `files`).
2. Compute target directory: `<SPACES_DIR>/<space-id>/<artefact-id>/`. Refuse if it exists *and* doesn't already belong to this artefact (collision protection).
3. Write each file under that directory, creating subdirectories as needed.
4. Insert (or update, if id existed) the DB row with `runtime_kind=static_dir`, `storage_config={path: "<abs>"}`, `runtime_config={entry: "index.html"}`, `source_origin='ai_generated'` (per the convention in CLAUDE.md).
5. Return the artefact id and URL.

**Idempotent on id** — calling `push_artifact` with the same id replaces the bundle's contents (with a touch of care: clear the directory first, then write, all under a try/finally; failed writes leave the previous version intact — write to a temp dir, then atomic rename).

**Atomic from the agent's perspective** — one MCP call places all files + creates the row, succeeds or fails as a unit. Today's two-step pattern (shell-write, then `register_artifact`) has a race where the agent registers before all files are flushed; `push_artifact` doesn't.

### Subdirectories — yes, by design

`push_artifact`'s `files[].path` accepts forward-slash paths of any depth. The server creates subdirectories as needed (`mkdir -p` semantics). So a real-world bundle looks like:

```js
push_artifact({
  space_id: "tokinvest",
  label: "Portfolio Redesign",
  files: [
    { path: "index.html",                 content: "..." },
    { path: "portfolio.html",             content: "..." },
    { path: "wallet.html",                content: "..." },
    { path: "assets/styles.css",          content: "..." },
    { path: "assets/prototype.js",        content: "..." },
    { path: "assets/images/logo.svg",     content: "..." },
    { path: "components/header.html",     content: "..." },
    { path: "components/nav/links.html",  content: "..." },
  ],
})
```

The `/a/<id>/*` resolver delegates to shared sub-path-resolution logic that handles arbitrary depth — `/a/portfolio-redesign/assets/images/logo.svg` resolves recursively inside the bundle's storage. No special-case code is needed for nesting.

Path safety: the validator rejects `..`, absolute paths, and paths starting with `/`. Each `path` must be a relative POSIX-style path within the bundle.

### Editing flow — how agents iterate after the initial push

These tools operate **only on managed bundles** (Pattern A). Linked bundles (Pattern B) are read-only from Oyster's side — the agent edits them via shell tools at the original path, just like it would any other file. Calling `update_file_in_artifact` on a linked bundle returns an error directing the agent to edit at the external path.

For managed bundles, three editing modes:

#### Mode 1 — Surgical edit: `update_file_in_artifact`

The common case. Agent has just changed one CSS rule or fixed one HTML link.

```js
update_file_in_artifact({
  artifact_id: "portfolio-redesign",
  path: "assets/styles.css",
  content: "/* updated */ ..."
})
```

Writes that one file (creating intermediate directories if needed). Other files untouched. New files can be added by passing a path that doesn't yet exist; the server creates it.

Returns: `{ ok: true, path: "assets/styles.css", bytes_written: 12345 }`.

#### Mode 2 — Full replace: `push_artifact` with the same id

When the agent has rebuilt the whole thing (e.g. just ran `vite build` and wants to publish the new `dist/`):

```js
push_artifact({
  id: "portfolio-redesign",     // ← same id as the existing bundle
  space_id: "tokinvest",
  label: "Portfolio Redesign",
  files: [ /* the entire new bundle */ ]
})
```

Atomic: server writes to `<id>.tmp/`, then renames over `<id>/` (failed pushes leave the previous bundle intact — no half-written state).

#### Mode 3 — Delete a file: `delete_file_in_artifact`

Removing a file that's no longer part of the bundle:

```js
delete_file_in_artifact({
  artifact_id: "portfolio-redesign",
  path: "assets/old-prototype.js"
})
```

Cheap to add alongside `update_file_in_artifact` (same validation, same path-resolution).

#### Discovery: `list_artifact_files`

So agents can see what's currently in a bundle before editing (no guessing):

```js
list_artifact_files({ artifact_id: "portfolio-redesign" })
// → [{ path: "index.html", bytes: 12345 }, { path: "assets/styles.css", ... }, ...]
```

#### Sidebar: editing managed bundles on disk (local install only)

For local installs, a managed bundle's directory is just a folder. The user *can* open `~/Oyster/spaces/tokinvest/portfolio-redesign/` in their editor and edit files directly — Oyster reads them at request time, so changes show up on the next refresh. This is a *local* convenience that exists because of how local storage happens to work, not a guaranteed feature. It doesn't translate to cloud (the bundle lives in object storage). The canonical agent flow stays MCP-based.

If the user *wants* the externally-edited model as the primary mode, that's what Pattern B (linked directory) is for — and it works identically locally and (where applicable) lets the user point Oyster at a folder they own.

## Coexistence with existing artefact types

| Existing | Status |
|---|---|
| `runtime_kind = 'static_file'` (single file) | unchanged. Still served at `/docs/<id>`. Markdown/Mermaid rendering preserved. |
| `runtime_kind = 'local_process'` (spawned process) | unchanged. Separate concern with its own MCP gap (see [project-level note](#out-of-scope)). |
| `runtime_kind = 'redirect'` (external URL) | unchanged. |
| `register_artifact` MCP tool | stays. Useful for "surface this file at a path I already control" (e.g. a `README.md` in a dev repo, registered in place — never copied). Local-install only. |
| `create_artifact` MCP tool | stays. For creating single-file content under the space's native folder. |
| Filesystem-discovered artefacts (the scanner) | unchanged. Still produces `static_file` and (broken) `local_process` artefacts from attached source folders. |

**No migration of existing artefacts.** Bundles and filesystem-discovered artefacts coexist forever. Old data stays exactly where it is.

## Forward compatibility

### Cloud Oyster

The MCP signature of `push_artifact` is identical whether the server is on localhost or `oyster.to`. Implementation differences are entirely behind the storage layer:

```
agent → push_artifact(files) → MCP server
                                 ├─ local install:  storage_kind='filesystem',   path: ~/Oyster/spaces/<space>/<id>/
                                 └─ cloud install:  storage_kind='object_store', bucket+prefix: s3://tenant/<space>/<id>/
```

The registry-aware `/a/<id>/*` route in cloud dispatches on `storage_kind` to read from object storage instead of the filesystem; everything else (URL shape, DB row shape, agent contract) is identical. Cloud Oyster ships when (a) auth/multi-tenancy lands, (b) the object-storage backend is wired into the route handler's storage dispatch. Bundles is the **prerequisite** that makes both achievable as additive work, not a rewrite.

### Sharing

Once artefacts are registry-keyed at `/a/<id>/*`, sharing is a small additive layer:

- **One new route**: `/p/<token>/*` → look up token → resolve to artefact id → reuse the same registry-aware serving logic as `/a/<id>/*`. No login, no Oyster chrome — bare bundle (or thin "made in Oyster" footer for attribution).
- **Tokens table**: `{token, artifact_id, created_at, expires_at?, revoked_at?}`.
- **One MCP tool**: `share_artifact(artefact_id, expires_in?) → URL`.
- **Recipient flow**: open `https://oyster.to/p/abc123/` → bundle renders. No account required. Owner can revoke.

This is **out of scope for this doc** — it's a 0.6.x ticket *after* bundles foundation lands. But the architecture choices in this doc (path-aware resolver, content-addressable directories, MCP-shipped bytes) are explicitly chosen to make sharing a thin layer rather than a rewrite.

### Hosted runtimes (much later)

If Oyster ever wants user-supplied processes in the cloud (a real `npm run dev` in a sandboxed container), that's a *different* tool — a future `push_app` that accepts a Dockerfile-like build spec, runs it in a metered sandbox, returns a URL. Not part of `push_artifact`'s contract. Static bundles cover ~95% of "demo a UI" cases without it.

## Implementation scope

After factoring out the static-serving primitives shared with `/artifacts/<relativePath>` (MIME, traversal-guard, directory-index, markdown/mermaid renderers), the new code is small:

| Piece | LOC | Notes |
|---|---|---|
| DB: add `'static_dir'` to allowed `runtime_kind` values; add new `ownership` column with values `'managed' \| 'linked'`, default `'linked'`; reserve `'object_store'` in `storage_kind` (for cloud) | ~25 | Idempotent ALTER, additive only |
| Server: registry-aware `/a/<artifact-id>/*` route handler (registry lookup + sub-path resolution + dispatch on `storage_kind`) | ~60 | Shares serving primitives with `/artifacts/<relativePath>` (extract MIME / dir-index / traversal-guard helpers). Initial impl: filesystem only. |
| `rowToArtifact`: emit `/a/<id>/` for `static_dir` | ~10 | One conditional, plus rel-path computation |
| `register_artifact` extension: accept directory paths → `storage_kind=filesystem, runtime_kind=static_dir, ownership=linked` (Pattern B) | ~30 | Validation: must be a directory; finds entry file |
| MCP: `push_artifact` tool (Pattern A) | ~80-120 | Validation, write, DB insert with `ownership=managed`, idempotent replace via temp+rename |
| MCP: `update_file_in_artifact` tool | ~30 | Refuses `ownership=linked`; surgical single-file edit |
| MCP: `delete_file_in_artifact` tool | ~20 | Same validation as update; trivial once update is in |
| MCP: `list_artifact_files` tool | ~25 | Read-only directory walk; works on both patterns (managed and linked) |
| Tests | ~250 | Path traversal, atomic replace, MIME types, directory index, idempotency, edit/delete/list flows, linked-vs-managed mutation rules, registry-aware route lookups |
| Docs + changelog | — | User-outcome framing per `feedback_changelog_style` |

Roughly **400-500 lines** with tests. **3-5 focused days** of work, plus review.

### Suggested PR shape

- **PR 1 — Foundation** (DB value, resolver directory-index, URL builder change). Bundles serve correctly when hand-created on disk + DB row inserted manually. Self-contained slice.
- **PR 2 — MCP** (`push_artifact`, `update_file_in_artifact`, `delete_file_in_artifact`, `list_artifact_files`). Agents can push, edit, and inspect.
- **PR 3 — Docs + changelog**. User-visible.

## Out of scope

These are real concerns but tracked separately to keep this milestone shippable:

- **`local_process` MCP gap.** MCP can't currently set `runtime_kind=local_process` or assign ports. Tracked as a separate follow-up (with a sibling ticket for port assignment). Local-install-only fix; not a cross-environment concern.
- **Sharing layer (`/p/<token>/*`).** Filed as 0.6.x follow-up after this lands.
- **Cloud storage backend.** Bundles' MCP contract is cloud-ready; the cloud build-out (auth, object storage, multi-tenancy) is a separate arc.
- **Plugin system unification.** Plugin `runtime: "static"` and artefact `runtime_kind: 'static_dir'` are structurally similar, but unifying their metadata (manifest vs DB row) is its own design question. Not blocking.

## Open questions

1. **`runtime_config.entry` default — `index.html`, or configurable per-artefact?** Lean: default to `index.html`, allow override via `runtime_config`. Most prototypes follow the convention; the override is cheap to support.
2. **Directory index trailing-slash redirect?** When the user visits `/a/portfolio-redesign` (no trailing slash), should the server 301 to `/a/portfolio-redesign/`? Probably yes — relative links inside the entry HTML resolve incorrectly without it.
3. **Idempotent replace strategy.** Write to `<id>.tmp/`, then `rename` over `<id>/`? Or write in place after clearing the directory? The first is atomic; the second is simpler. Lean: temp+rename.
4. **Bundle size limit.** Should `push_artifact` cap total payload size (e.g. 50MB)? Reasonable for cloud, less critical locally. Lean: cap, configurable via env var.
5. ~~**Should `register_artifact` also accept `runtime_kind=static_dir`?**~~ Resolved — yes, this is Pattern B (linked directory) and is now first-class in the design. `register_artifact` extension to accept directory paths and emit `storage_kind=filesystem, runtime_kind=static_dir`.

## References

- **Trigger incident**: tokinvest portfolio-redesign prototype (2026-04-28). Multi-file SPA, agent registered `index.html` as `static_file`, meta-refresh to `portfolio.html` 404'd because `/docs/portfolio.html` looked up an artefact named `portfolio.html` rather than serving a sibling file. Forced collapse to a single-file SPA.
- **Existing resolver** (serving primitives reused — MIME, traversal-guard, markdown/mermaid renderers): `server/src/index.ts:961-998` (`/artifacts/<relativePath>` static serving) and `server/src/index.ts:164-...` (`resolveArtifactsUrl` walker). The new `/a/<id>/*` route is a registry-aware wrapper that calls into the same lower-layer serving primitives — it does not replace the `/artifacts/...` route.
- **`/docs/<id>` route** (unchanged): `server/src/index.ts:869-895`.
- **Artefact DB schema**: `server/src/artifact-store.ts:73-83`.
- **MCP tool registration**: `server/src/mcp-server.ts:606-637` (`register_artifact` for reference).
- **Plugin system naming**: [apps-system.md](./apps-system.md) — `runtime: "static"` and `runtime: "bundle"` for plugins.
- **Adjacent gap**: `local_process` runtime cannot be set via MCP — separate ticket.
