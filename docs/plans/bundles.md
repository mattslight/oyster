# Multi-file static artefacts ("bundles") — Design Notes

> **Status (2026-04-28):** Proposed. Triggered by the tokinvest portfolio-redesign prototype incident, which surfaced a real gap: an agent can register a single file or a process, but not "this folder of HTML/CSS/JS as one artefact." Targets the **0.6.0** milestone — no implementation in flight yet.

## Core Insight

**Today's artefact taxonomy has a hole in the middle.**

| Need | Today |
|---|---|
| External link (e.g. a Figma URL) | ✅ `runtime_kind = 'redirect'` |
| Single document (`.md`, `.html`, single-file SPA) | ✅ `runtime_kind = 'static_file'`, served at `/docs/<id>` |
| **Multi-file static thing** (a `vite build` output, Storybook export, clickable demo) | ❌ **missing** |
| Local-runnable app (needs `npm run dev`) | ⚠️ `runtime_kind = 'local_process'` exists, but [can't be set via MCP](./../../) — separate gap |

A folder of HTML/CSS/JS *can be moved onto disk* under `~/Oyster/spaces/<space>/`, but Oyster has no concept of "this folder is one logical artefact." Today's only way to register multi-file content is to register *one* file inside the folder via `register_artifact` — which serves only that file at `/docs/<id>`. Sibling files are unreachable through any registered artefact URL. This is the wall the tokinvest prototype hit: `index.html` was registered, the meta-refresh to `portfolio.html` resolved to `/docs/portfolio.html` (a different, non-existent artefact id), 404.

The fix is to introduce a **multi-file static artefact** as a new `runtime_kind`, served via the existing `/artifacts/<...>` resolver with a directory-index helper, and a new MCP tool that lets agents *ship bytes* (rather than register a server-side filesystem path) — so the same primitive works locally and in cloud.

## Why this matters beyond the immediate gap

Three things ride on this single change:

1. **Multi-file prototypes work.** The most common artefact an agent produces today (a clickable HTML demo with sibling files) becomes registerable in one MCP call.
2. **Cloud Oyster becomes feasible.** Today's `register_artifact` requires a server-readable filesystem path — only works because agent and server share a laptop. The new `push_artifact` ships bytes through the MCP channel itself; identical signature whether the server is `localhost:4444` or `oyster.to`. Same primitive, two storage backends.
3. **Sharing-with-others becomes a thin layer on top.** Once artefacts are content-addressable directories served at `/artifacts/<...>/*`, a shared route at `/p/<token>/*` reuses the same resolver behind a different auth gate. ~1 day of work *after* this lands. See "Forward compatibility" below.

This is the foundational change that unlocks the next two arcs (cloud + sharing). It is not a plugin runtime, it is not a runtime-process change, it is not a sharing feature — it is the *primitive* those things sit on.

## Naming — and why not just call it "bundle"

The word **bundle** is already taken in the plugin/app system (see [apps-system.md](./apps-system.md) line 30): `runtime: "bundle"` means an *esbuild-output JS plugin* that runs in a sandboxed iframe and talks to the host via `postMessage`. That's a distinct future concern with its own SDK and capabilities model.

This doc proposes **`runtime_kind: 'static_dir'`** for the new artefact runtime — parallel to the existing `static_file`, distinct from the plugin world's `bundle`. In prose we may informally say "bundle artefact" (because "a bundle of files" is intuitive English), but the schema name is `static_dir` to avoid the collision.

| Domain | Term | Meaning |
|---|---|---|
| Plugins (apps-system.md) | `runtime: "static"` | Folder of HTML, served as iframe artifact (e.g. zombie-horde) |
| Plugins (apps-system.md) | `runtime: "bundle"` *(future)* | esbuild JS, sandboxed iframe + SDK + postMessage |
| Artefacts (this doc) | `runtime_kind: 'static_file'` | Single file, served at `/docs/<id>` |
| Artefacts (this doc) | `runtime_kind: 'static_dir'` *(new)* | Directory, served at `/artifacts/spaces/<space>/<id>/` |

Plugin `runtime: "static"` and artefact `runtime_kind: 'static_dir'` are structurally similar (both are folders served as iframes). The serving infrastructure is the existing `/artifacts/<...>` resolver — both already use it. The metadata layer differs (plugins have a manifest; artefacts have a DB row) and that's fine.

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

DB row shape:

```
id:              portfolio-redesign
space_id:        tokinvest
artifact_kind:   app
storage_kind:    filesystem
storage_config:  {"path": "<absolute path to bundle directory>"}
runtime_kind:    static_dir
runtime_config:  {"entry": "index.html"}     ← optional, defaults to index.html
source_origin:   ai_generated | manual
```

`storage_kind` stays `filesystem` (bytes live on a filesystem-shaped surface — the local filesystem on a workstation, an S3/R2 mount in cloud). `runtime_kind` is what shifts.

### Serving

The existing `/artifacts/<relativePath>` resolver (`server/src/index.ts:961-998`) already walks `OYSTER_HOME`, `APPS_DIR`, and `SPACES_DIR` looking for files. Plugin `runtime: "static"` content uses it. Multi-file artefacts use the **same** resolver — no new route handler.

A static_dir artefact at `~/Oyster/spaces/tokinvest/portfolio-redesign/` is served at:

- `/artifacts/spaces/tokinvest/portfolio-redesign/` → `index.html` *(directory index)*
- `/artifacts/spaces/tokinvest/portfolio-redesign/portfolio.html` → that file
- `/artifacts/spaces/tokinvest/portfolio-redesign/assets/styles.css` → that file

The only **net-new behaviour** in the resolver is **directory-index handling**: when the resolved path is a directory, serve `runtime_config.entry` (default `index.html`) from inside it instead of returning 404. That's a ~10-line change to `resolveArtifactsUrl` or its caller.

The artefact's `url` field (returned by the API and used by the web app's iframe) is set by `rowToArtifact` in `artifact-service.ts`:

```ts
url = row.runtime_kind === 'static_dir'
  ? `/artifacts/${storage.path-relative-to-OYSTER_HOME}/`     // trailing slash → relative links inside resolve correctly
  : `/docs/${row.id}`;                                        // unchanged for static_file
```

The frontend already opens `artifact.url` in an iframe — no web change required.

### MCP — `push_artifact`

The cloud-relevant piece. Today's `register_artifact` takes a server-readable filesystem path; that only works because the agent and server happen to share a filesystem. `push_artifact` takes the actual bytes.

```js
push_artifact({
  space_id: "tokinvest",
  label: "Portfolio Redesign",
  kind: "app",                            // optional, inferred if omitted
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

The `/artifacts/<...>` resolver already handles arbitrary path depth — sub-paths like `/artifacts/spaces/tokinvest/portfolio-redesign/assets/images/logo.svg` resolve recursively under `OYSTER_HOME`. No special-case code is needed for nesting.

Path safety: the validator rejects `..`, absolute paths, and paths starting with `/`. Each `path` must be a relative POSIX-style path within the bundle.

### Editing flow — how agents iterate after the initial push

This is the core iteration loop, so it's first-class in v1, not optional. Three editing modes:

#### Mode 1 — Surgical edit: `update_file_in_bundle`

The common case. Agent has just changed one CSS rule or fixed one HTML link.

```js
update_file_in_bundle({
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

#### Mode 3 — Delete a file: `delete_file_in_bundle`

Removing a file that's no longer part of the bundle:

```js
delete_file_in_bundle({
  artifact_id: "portfolio-redesign",
  path: "assets/old-prototype.js"
})
```

Cheap to add alongside `update_file_in_bundle` (same validation, same path-resolution).

#### Discovery: `list_bundle_files`

So agents can see what's currently in a bundle before editing (no guessing):

```js
list_bundle_files({ artifact_id: "portfolio-redesign" })
// → [{ path: "index.html", bytes: 12345 }, { path: "assets/styles.css", ... }, ...]
```

#### Sidebar: editing on disk (local install only)

For local installs, the bundle directory is just a folder. The user can open `~/Oyster/spaces/tokinvest/portfolio-redesign/` in their editor and edit files directly — Oyster reads them at request time, so changes show up on the next refresh. This is a *local* convenience and doesn't translate to cloud (where the bundle lives in object storage). Document it in the user-facing changelog as a feature, but the canonical agent flow stays MCP-based.

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
                                 ├─ local install:  ~/Oyster/spaces/<space>/<id>/
                                 └─ cloud install:  s3://tenant-bucket/<space>/<id>/
```

The `/artifacts/<relativePath>` resolver in cloud reads from object storage instead of the filesystem; everything else (URL shape, DB row shape, agent contract) is identical. Cloud Oyster ships when (a) auth/multi-tenancy lands, (b) object-storage backend is wired into the resolver. Bundles is the **prerequisite** that makes both achievable as additive work, not a rewrite.

### Sharing

Once artefacts are directory-served at `/artifacts/<...>/*`, sharing is a small additive layer:

- **One new route**: `/p/<token>/*` → look up token → resolve to artefact's bundle directory → serve via the same resolver. No login, no Oyster chrome — bare bundle (or thin "made in Oyster" footer for attribution).
- **Tokens table**: `{token, artifact_id, created_at, expires_at?, revoked_at?}`.
- **One MCP tool**: `share_artifact(artefact_id, expires_in?) → URL`.
- **Recipient flow**: open `https://oyster.to/p/abc123/` → bundle renders. No account required. Owner can revoke.

This is **out of scope for this doc** — it's a 0.6.x ticket *after* bundles foundation lands. But the architecture choices in this doc (path-aware resolver, content-addressable directories, MCP-shipped bytes) are explicitly chosen to make sharing a thin layer rather than a rewrite.

### Hosted runtimes (much later)

If Oyster ever wants user-supplied processes in the cloud (a real `npm run dev` in a sandboxed container), that's a *different* tool — a future `push_app` that accepts a Dockerfile-like build spec, runs it in a metered sandbox, returns a URL. Not part of `push_artifact`'s contract. Static bundles cover ~95% of "demo a UI" cases without it.

## Implementation scope

After accounting for the existing `/artifacts/<...>` resolver doing most of the serving, the change is smaller than initially estimated:

| Piece | LOC | Notes |
|---|---|---|
| DB: add `'static_dir'` to allowed `runtime_kind` values | ~10 | Idempotent ALTER, additive only |
| Resolver: directory-index helper (serve `entry` from a resolved directory) | ~20 | Inside or alongside `resolveArtifactsUrl` |
| `rowToArtifact`: emit `/artifacts/<rel-path>/` for `static_dir` | ~5 | One conditional |
| MCP: `push_artifact` tool | ~80-120 | Validation, write, DB insert, idempotent replace via temp+rename |
| MCP: `update_file_in_bundle` tool | ~30 | Surgical single-file edit |
| MCP: `delete_file_in_bundle` tool | ~20 | Same validation as update; trivial once update is in |
| MCP: `list_bundle_files` tool | ~20 | Read-only directory walk |
| Tests | ~180 | Path traversal, atomic replace, MIME types, directory index, idempotency, edit/delete/list flows |
| Docs + changelog | — | User-outcome framing per `feedback_changelog_style` |

Roughly **350-450 lines** with tests. **3-4 focused days** of work, plus review.

### Suggested PR shape

- **PR 1 — Foundation** (DB value, resolver directory-index, URL builder change). Bundles serve correctly when hand-created on disk + DB row inserted manually. Self-contained slice.
- **PR 2 — MCP** (`push_artifact`, `update_file_in_bundle`, `delete_file_in_bundle`, `list_bundle_files`). Agents can push, edit, and inspect.
- **PR 3 — Docs + changelog**. User-visible.

## Out of scope

These are real concerns but tracked separately to keep this milestone shippable:

- **`local_process` MCP gap.** MCP can't currently set `runtime_kind=local_process` or assign ports. Tracked in `project_mcp_runtime_gap.md` (and a sibling ticket). Local-install-only fix; not a cross-environment concern.
- **Sharing layer (`/p/<token>/*`).** Filed as 0.6.x follow-up after this lands.
- **Cloud storage backend.** Bundles' MCP contract is cloud-ready; the cloud build-out (auth, object storage, multi-tenancy) is a separate arc.
- **Plugin system unification.** Plugin `runtime: "static"` and artefact `runtime_kind: 'static_dir'` are structurally similar, but unifying their metadata (manifest vs DB row) is its own design question. Not blocking.

## Open questions

1. **`runtime_config.entry` default — `index.html`, or configurable per-artefact?** Lean: default to `index.html`, allow override via `runtime_config`. Most prototypes follow the convention; the override is cheap to support.
2. **Directory index trailing-slash redirect?** When the user visits `/artifacts/.../portfolio-redesign` (no trailing slash), should the server 301 to `/artifacts/.../portfolio-redesign/`? Probably yes — relative links inside the entry HTML resolve incorrectly without it.
3. **Idempotent replace strategy.** Write to `<id>.tmp/`, then `rename` over `<id>/`? Or write in place after clearing the directory? The first is atomic; the second is simpler. Lean: temp+rename.
4. **Bundle size limit.** Should `push_artifact` cap total payload size (e.g. 50MB)? Reasonable for cloud, less critical locally. Lean: cap, configurable via env var.
5. **Should `register_artifact` also accept `runtime_kind=static_dir`** (for "I already have a directory at this path on my disk, surface it as a multi-file artefact")? Useful for local-discovery cases. Probably yes — small extension.

## References

- **Trigger incident**: tokinvest portfolio-redesign prototype (2026-04-28). Multi-file SPA, agent registered `index.html` as `static_file`, meta-refresh to `portfolio.html` 404'd because `/docs/portfolio.html` looked up an artefact named `portfolio.html` rather than serving a sibling file. Forced collapse to a single-file SPA.
- **Existing resolver** (reused, not replaced): `server/src/index.ts:961-998` (`/artifacts/<relativePath>` static serving) and `server/src/index.ts:164-...` (`resolveArtifactsUrl` walker).
- **`/docs/<id>` route** (unchanged): `server/src/index.ts:869-895`.
- **Artefact DB schema**: `server/src/artifact-store.ts:73-83`.
- **MCP tool registration**: `server/src/mcp-server.ts:606-637` (`register_artifact` for reference).
- **Plugin system naming**: [apps-system.md](./apps-system.md) — `runtime: "static"` and `runtime: "bundle"` for plugins.
- **Adjacent gap**: `local_process` runtime cannot be set via MCP — separate ticket.
