# Userland Layout & Visibility — Design Spec

> **Status (2026-04-24):** Draft. Merges #172 (internal layout) + #182 (visibility/location) into a single piece of work. Written for discussion before implementation — no code until approved.

## Problem

Two issues, one user experience:

- **#182** — Users can't find their workspace. It's stashed in `~/.oyster/userland/`, a dotted hidden directory. Merlin's Windows UAT (2026-04-21) expected it in `E:\Development\`. Every new user trips over this.
- **#172** — Once found, `userland/` is a grab-bag: system DBs, config, artifact folders, orphan files, and loose notes all at the same level. Users can't tell what's safe to touch, and there's no structure for export/sync (#94) to build on.

Fixing one without the other is wasted work: making the current grab-bag *more visible* just exposes the mess faster.

## Goal

A new user should be able to

1. **Find their Oyster workspace without help** — it's in a visible folder, where they'd expect their work to live.
2. **Make sense of what's inside it** — every top-level folder has an obvious role.

## Shape

```
~/Oyster/
├── db/          oyster.db + memory.db (core system state)
├── config/      opencode.json
├── apps/        everything with a manifest.json (installable bundles)
├── backups/     existing backup-YYYY-MM-DD/ pattern
└── spaces/      one folder per user space, holds Oyster-owned content for that space
    ├── home/
    ├── tokinvest/
    │   ├── invoices/
    │   ├── research/
    │   └── presentations/
    ├── blunderfixer/
    └── oyster/
```

Five top-level concepts. Every one named in plain English. Nothing speculative.

### Why `spaces/` wraps the space folders

A user can create a space called "db", "config", "apps" — we don't want space names colliding with system folders. Wrapping them under `spaces/` gives clear separation: anything *inside* `spaces/` is user content; everything else at the root is Oyster's system state.

### Why not `userland/`?

The outer `~/Oyster/` is already user data — there's no package content next to it that needs distinguishing. The extra `userland/` level was meaningful when `.oyster/` also held package-internal state; today it doesn't. Drop it.

### Why not `plugins/`?

OSes since the dawn of computing have had **apps**. Plugins is framework/IDE jargon (Obsidian, VS Code, browsers) and requires explanation. Every "installable thing" in Oyster — builtins, community installs, user-published apps, future hotpluggable backends — is an app. The manifest declares what kind.

### Spaces, sources, artifacts — four concepts, cleanly separated

This spec's target mental model:

- **Space** = a logical bucket in the DB (`oyster.db`). Not a folder, not a repo.
- **Source** = a place content comes from. Today: external registered repos + the space's own folder. Future: pinned single files, cloud docs, etc.
- **Artifact** = a surfaced thing (note, app, deck, diagram) — always attached to exactly one space, always tied back to exactly one source.
- **View / group** = how the surface organises artifacts visually (per #192 tags, per #193 saved queries, per current `group_name`).

The critical decision: **filesystem folders are not the source of truth for space membership.** The DB is. The `~/Oyster/spaces/<space-id>/` folder is a *convenience for humans* — a default, self-describing native source — not the definition of the space. If a user deletes that folder manually, the space still exists in the DB; its native source just reports "missing" until the user restores it.

### Two kinds of source today, more planned

A space draws content from:

1. **External registered repos** (zero or many) — live at their own paths (e.g. `~/Dev/oyster-os/`). Detector walks them; artifacts surface into the space without copying files.
2. **The space's native folder** at `~/Oyster/spaces/<space-id>/` — always created when the space is created. Where `create_artifact` writes homeless content (invoices, research, loose notes). Human-readable, self-describing, survives Oyster being closed or broken.

Future: pinned individual files (`type: file`), cloud sources (`type: cloud`) — same sources abstraction, new `type` values.

Both kinds surface equally on the surface. A user seeing an invoice tile doesn't know or care whether it came from the native folder or a registered repo.

### Why every space has its own native folder

Robustness and clarity. A file at `~/Oyster/spaces/tokinvest/invoices/ms-2026-001.md` is self-describing — if Oyster crashes, the DB corrupts, or you're in Finder with Oyster closed, you can still see what the file is and which space it's attached to. A flat `files/<uuid>.md` bucket optimises for cheap reorgs at the cost of everyday legibility. Moves between spaces are rare (invoices don't become oyster specs); reading and finding files is constant.

Cross-cutting queries ("all invoices across all spaces") don't need physical duplication — they're **views** (#193), saved queries over the DB. Physical native folders and views aren't in conflict; they do different jobs.

### V1 implementation: layout now, `sources` table later

This spec (the merged #172+#182 work) does the physical layout migration only. It does *not* introduce a `sources` table. The current `space_paths` table stays, with one small semantic shift: the space's native folder is treated as an implicit `native` source (created when the space is created; not stored as a row). External repos continue to attach via `space_paths` as they do today.

The first-class `sources` table — replacing `space_paths` with a typed table that cleanly models native / repo / file / cloud sources and their lifecycles — is a **follow-up design ticket** (see "Follow-ups" below). It's the right target; it's a bigger change than should ride a layout migration. Sequencing keeps each PR atomic.

What this means in practice:
- V1 code **must not assume** `space_id` equals the folder name as a hard invariant — use a resolver function that returns the native source path for a space, so swapping to a `sources` table later is a single-file change.
- V1 migration **must not delete** a space if its native folder is missing — log and carry on.
- V1 MCP tools (`onboard_space`, etc.) keep their current shapes; new source-aware verbs come with the refactor.

### Folders are sources, not tiles

The surface shows *detected artifacts* (things you read or run), not folders. When a folder (whether `~/Dev/oyster-os/` or `~/Oyster/apps/zombie-horde/`) is involved, the detector walks it and surfaces matching items — `.md` → notes, `manifest.json` → app, `package.json`+dev script → runnable app. Raw source files never appear on the surface.

What *looks* like "the repo as a tile" is always actually an artifact detected inside it (usually the runnable app). No "folder tile" primitive exists or is planned.

### External filesystem moves — not supported in v1

If a user drags `~/Oyster/spaces/tokinvest/invoice.md` to `~/Oyster/spaces/oyster/` in Finder while Oyster is running, Oyster won't reconcile. The rule in v1: **move via Oyster (MCP `move_artifact` in #192), not via Finder.** Self-heal via file-watcher is doable later (out of scope for this spec).

## The apps-as-everything model

Every installable thing lives in `apps/<id>/` with a `manifest.json`. The manifest's `type` (and related fields) declares what Oyster should do with it.

```json
// classic app — launch in a window
{ "id": "car-racer", "type": "app", "runtime": "static" }

// widget — live on the surface
{ "id": "clock", "type": "widget", "runtime": "static" }

// service — no UI, swaps a core backend
{ "id": "memory-mem0", "type": "service", "provides": "memory" }

// builtin — ships with Oyster
{ "id": "connect-your-ai", "type": "app", "source": "builtin" }
```

Oyster's loader reads the manifest and wires up accordingly:

- `type: app` → launchable, gets a surface tile
- `type: widget` → mounts on the surface directly
- `type: service, provides: memory` → swaps in as the memory backend
- `source: builtin` → UI gates destructive operations (delete / edit)

This aligns with how `docs/plans/plugin-system.md` already frames it ("apps and plugins are the same concern"); this spec commits to **app** as the dominant noun.

### Lifecycle ownership

Different folders have different write-ownership rules. Oyster can edit content everywhere the user invites it to; what differs is who owns the *lifecycle* (install, version, deploy).

| Folder / source | Can Oyster edit content? | Who owns the lifecycle? |
|---|---|---|
| Registered external repo (`~/Dev/oyster-os`) | Yes — via agent, MCP, or user | **User / git** — branches, commits, PRs, deploys. Oyster is a collaborator, not the owner. |
| Oyster-owned app (`~/Oyster/apps/<id>/`) | No — install / update / uninstall only | **Oyster** — atomic unit, updates replace the bundle. User edits are expected to get clobbered on next update. |
| Oyster-owned files (`~/Oyster/files/`) | Yes | User, via Oyster's UI (and optionally git, if they choose) |
| Core system (`~/Oyster/db/`, `~/Oyster/config/`) | Internal only | Oyster |

### Bundle discipline (borrowed from macOS `.app`)

Inside an app bundle in `apps/<id>/`: everything the app needs to run. Transient state (caches, local databases the app owns, temp data) stays inside the bundle — uninstalling the app disposes of it cleanly.

Durable user data that should survive swapping the app out lives **outside** the bundle:
- The user's actual memories live in `db/memory.db` (Oyster-owned).
- A hypothetical `apps/memory-mem0/` app's *cache* lives inside its bundle. If the user removes the app, the cache goes; the memories in `db/memory.db` remain.

This is the macOS `/Applications` (disposable bundle) vs `~/Library/Application Support/` (durable user data) split, applied.

### Where published apps come from

Lifecycle: `files/my-thing/` → user hits "publish" → packaged with manifest → moves to `apps/my-thing/`. Reversible.

### Where hotpluggable memory goes

Today: memory is SQLite-only, built into the core. `memory.db` lives at `db/memory.db`.

Later: a memory app (mem0, supermemory) drops into `apps/memory-mem0/` with `type: service, provides: memory`. Oyster's loader sees the declared capability and wires it up. The memory app owns its own storage (cache, config) inside its folder. `db/memory.db` stays as the default-backend store; if the user activates a non-default backend, the default is idle but preserved.

**No separate `plugins/` or `extensions/` folder needed, now or later.**

## What lives where

### `db/` — core system state

- `oyster.db` — artifact + space registry. Always present. Core. Not pluggable.
- `memory.db` — default SQLite memory store. Present until/unless replaced by a memory-provider app.
- `*.db-shm`, `*.db-wal` — SQLite sidecars.

Visible, not hidden. Users should be able to find backups.

### `config/` — core config

- `opencode.json` — AI engine config.
- `.opencode/agents/oyster.md`, `.opencode/config.toml` — OpenCode sub-config. Currently lives at userland root; moves under `config/.opencode/` so all config is in one place.

### `apps/` — installable bundles

- Builtins (`connect-your-ai`, `quick-start`, `import-from-ai`, `the-worlds-your-oyster`) — shipped with the npm package, copied on first run.
- User-installed (community): `pomodoro`, etc.
- User-published: `my-app/` after promotion from `files/`.

Each has `manifest.json`. UI distinguishes them via manifest `source` field.

### `backups/` — snapshots

Existing `backup-YYYY-MM-DD-HHMMSS/` pattern. Un-hide (currently `.backups`), keep the naming.

### `spaces/` — user work organised by space

One subfolder per user space. A space's folder holds content Oyster created or was asked to own for that space:

```
spaces/tokinvest/
├── invoices/
│   ├── ms-2026-001.md
│   └── ms-2026-002.md
├── research/
│   ├── competitor-analysis.md
│   └── market-research.md
├── presentations/
│   └── portal-redesign-proposal.html
└── loose-note.md
```

- Single-file artifacts sit at the space root or in a subdir: `spaces/home/team-brief.md`, `spaces/tokinvest/invoices/ms-2026-001.md`
- Multi-file artifacts get a folder: `spaces/home/car-racer/{manifest.json, src/}` — unless/until promoted to `apps/`
- Subdirs (`invoices/`, `research/`) are optional organisation. `create_artifact`'s existing `subdir` parameter writes straight into them.
- **Registered external repos don't live here** — they stay at their own paths (`~/Dev/oyster-os/`, `~/Dev/tokinvest-website/`). The `space_paths` table points at them.

The `home` space is the default landing zone when no space is specified. Always exists.

## Migration

### Strategy: manual one-off reorg for the author's prod, fresh install for everyone else

Early-user audit (2026-04-24): only the author's install has meaningful registered content. Bharat's and Merlin's installs are fresh / effectively empty — they reinstall on the new version with no migration. No one else is running the app yet.

That removes the pressure to ship a baked-in idempotent startup migration. The reorg happens once, by hand, on the author's prod (with the snapshot already captured at `~/oyster-backups/manual/pre-207-2026-04-24/` for rollback). The server code in this PR is built for the new layout from day one.

Consequence: this PR adds **no migration code to the server**. If a future user surfaces with pre-migration data, we ship a standalone migration tool then.

On server startup:

Manual reorg steps for the author's prod (performed once by hand before the new version runs):

1. Stop Oyster if running.
2. Create `~/Oyster/{db,config,apps,backups,spaces}/`.
3. `mv ~/.oyster/userland/oyster.db*` → `~/Oyster/db/`.
4. `mv ~/.oyster/userland/memory.db*` → `~/Oyster/db/`.
5. `mv` each shipped builtin folder (`connect-your-ai`, `import-from-ai`, `quick-start`, `the-worlds-your-oyster`, `zombie-horde`) → `~/Oyster/apps/`.
6. `mv` each AI-generated app folder (those with `manifest.json` not in the builtin list) → `~/Oyster/spaces/<owning-space>/<app-id>/` — the owning space comes from the DB row's `space_id`.
7. `mv` each space folder (matches a row in the `spaces` table) → `~/Oyster/spaces/<space-id>/`.
8. `mv` loose files (`*.md`, `*.html` at the old root) → `~/Oyster/spaces/<their-space-from-DB>/<filename>` (default `home` if not registered).
9. Keep `.opencode/` and `opencode.json` at `~/Oyster/` root — opencode-ai discovers them via CWD walk-up, so they must stay accessible to its search path.
10. Delete root-level orphans (`manifest.json`, `icon.png`, `src/`, `icons/`).
11. Update `artifacts.storage_config.path` rows via a one-off SQL pass: for each row whose path starts with `~/.oyster/userland/`, rewrite the prefix to the corresponding new location.
12. Verify by running the new server build and confirming artifacts still resolve on the surface.

### Dev mode

In dev, `OYSTER_HOME` resolves to `./userland/` (repo-relative, `.gitignore`-excluded). The env var `OYSTER_USERLAND` overrides for testing. Dev installs that existed pre-refactor can be blown away and re-generated — nobody's running dev with real data.

## Orphan cleanup (during migration)

Root-level orphans today (from the #172 sample):

- `icon.png`, `icons/` — left over from failed artifact creations
- `src/` — stray app source with no owning manifest
- `manifest.json` at the root — partial write

**Decision: delete them on migration, log names.**

Rationale: they're known-broken leftovers (the generator started, failed before registering). Moving them to a quarantine folder just creates a new mystery folder users have to learn about. If we log what we deleted, users who care can recover from `backups/pre-migration-*/`.

## Naming collisions

Within `files/`, two single-file artifacts could have the same name (e.g. two home-space notes called `brief.md`). Current behaviour: `create_artifact` in `artifact-service.ts` handles this by generating unique filenames on creation. Need to verify this during migration — if any two existing artifacts would land at the same path in `files/`, append a suffix (`brief-1.md`) and update `storage_config.path` accordingly.

Same applies inside `apps/`: two apps with the same `id` shouldn't exist today (DB enforces), but migration should defend against it.

## Terminology cascade

The `plugin → app` rename affects more than code:

### Documentation
- `CLAUDE.md` — update userland path references (~/.oyster/userland → ~/Oyster; drop "userland" term entirely)
- `docs/plans/plugin-system.md` — rename to `apps-system.md`, update noun throughout
- `docs/plans/oyster-os-design.md` — update path + terminology
- `docs/launch-readiness-2026-04-23.md` — update any userland references

### Website (follow-up PRs to `docs/` pages that ship to oyster.to)
- `docs/plugins.html` — rename file to `apps.html`, update copy from "plugins" to "apps"
- `docs/CNAME` and any internal links that point to `/plugins`
- Main `docs/index.html` — check for any plugin references
- Meta description: "Community plugins for Oyster" → "Community apps for Oyster"

### Sample repo
- `github.com/mattslight/oyster-sample-plugin` → rename to `oyster-sample-app`
- README inside that repo updated to use "app" noun
- Update the install command example (`oyster install mattslight/oyster-sample-app`)
- Keep the old repo name as a redirect (GitHub handles this automatically on rename)

### Code
- Artifact detector currently scans for "plugin" folders — rename paths + variables
- MCP tool names that leak "plugin" terminology
- User-facing copy in the UI (if any — grep will tell us)

## Updates to code paths

Hot spots (from grep):

- `server/src/index.ts:109-111` — `USERLAND_DIR` computation. Becomes `OYSTER_HOME`; inside it, derive `DB_DIR`, `CONFIG_DIR`, `APPS_DIR`, `SPACES_DIR`, `BACKUPS_DIR`.
- `server/src/db.ts` — `initDb(USERLAND_DIR)` → `initDb(DB_DIR)`.
- `server/src/memory-store.ts` → uses `DB_DIR/memory.db`.
- `server/src/artifact-service.ts:317` — `createArtifact` computes `baseDir = join(userlandDir, space_id)`. Becomes `join(SPACES_DIR, space_id)`. The space_id-as-folder-name pattern is preserved — that's the correct model — the base directory just shifts.
- `server/src/artifact-detector.ts` — scans `APPS_DIR` (manifests for installed apps) and `SPACES_DIR` (loose files per space). Update stale comments at :11-14 and :179.
- `server/src/mcp-server.ts:568` — update `register_artifact` description (remove "The file must be inside userland/" — no longer the rule).
- `server/src/backup.ts:36` — dev detection heuristic, update to `Oyster/` root.
- `server/src/space-service.ts:130` — `convertFolderToSpace` is fine semantically, but the name's confusing. Rename to `reassignGroupToSpace` deferred to a follow-up (cascades into the web client; scope expansion for this PR).
- `server/src/import.ts`, `server/src/opencode-manager.ts` — any hardcoded userland references.

Each constant gets a single definition and flows through everywhere. No scattered `join(USERLAND_DIR, ...)` to miss.

## Agent playbook update (same PR)

`.opencode/agents/oyster.md` needs a sharper rule on **where new content goes**:

- **Content attached to a space** (invoices, research, notes, presentations, generated apps): always use `create_artifact` via MCP. Never raw-write into a repo. The MCP tool handles landing it in the correct physical location (`~/Oyster/spaces/<space>/...`) and registering it in one step.
- **Editing existing code in a registered repo**: normal file writes are fine. The repo owns that content; Oyster is a collaborator, not the owner.

The current state of the author's tokinvest work illustrates the failure mode: market research, competitor analysis, invoices, and presentations all drifted into one of the registered tokinvest repos because the agent used raw file writes instead of `create_artifact`. With the rule clarified, new homeless content lands at `~/Oyster/spaces/tokinvest/` and the repos stay focused on code.

## Sequencing

Everything below lives inside **one PR** to keep the migration atomic:

1. Define new path constants (`OYSTER_HOME`, `DB_DIR`, `APPS_DIR`, etc.).
2. Route code through them.
3. Add migration function, run on startup before anything else touches disk.
4. Update `CLAUDE.md`, spec docs.
5. Website + sample-repo renames go in **follow-up PRs** (not blocking; launch can ship with old URLs redirecting).

## Open questions (answered)

Carrying forward for the record:

- **Location: `~/Oyster/` vs `~/.oyster/`** — **`~/Oyster/`** (visible). Windows and macOS users expect their work in a non-hidden folder.
- **`plugins/` vs `apps/`** — **`apps/`**, single folder, manifest declares capability.
- **Where do AI-generated apps live?** — **`spaces/<space-id>/<app-id>/`** (under the space they were created in), not `apps/`. `apps/` is reserved for things Oyster installed (builtins + community). Generated apps can be promoted to `apps/` on explicit publish.
- **Flat `files/` bucket vs `spaces/<space-id>/` folders?** — **spaces folders**. Content is self-describing on disk, survives DB issues, and everyday legibility beats cheap cross-space moves. Moves are rare; finding files is constant.
- **`db/` visible or hidden?** — **visible**. Backups discoverable; no reason to hide registry.
- **Memory.db location with future hotplug?** — default stays at `db/memory.db`; hotplug apps own their own storage inside `apps/<id>/`.
- **External filesystem moves (drag in Finder)?** — not supported in v1. Rule: move via Oyster. Self-heal via file-watcher is future work.

## Out of scope

- Publishing flow UI (`spaces/<s>/my-thing/` → `apps/my-thing/` promotion) — separate ticket, post-launch.
- Views-as-queries (#193) — independent work. This spec doesn't block or advance it; the layout just stops actively working against it.
- Tier 2 / Tier 3 app installers (see `plugin-system.md` → `apps-system.md`) — future work.
- Multiple userlands / per-project workspaces (option C in #182) — deferred.
- **First-class `sources` table** — the target model but not this PR. See follow-ups.

## Follow-ups (filed alongside the merged ticket)

Not in the merged #172+#182 PR, but captured so the full picture is visible:

- **Sources refactor (design ticket)** — replace `space_paths` with a typed `sources` table supporting `native | repo | file | cloud`, with explicit lifecycle (add / remove → cascade artifacts). Subsumes several of the below:
  - Detach is a bug today (removes `space_paths` row but orphans artifacts) → structurally fixed.
  - Rename tracking — per-source watchers are the clean place to hook this.
  - Visual provenance on the surface — `source.type` and `source.path` become natural tile metadata.
  - Path-health indicator — becomes a per-source state, not an artifact-by-artifact check.
  - Scanner coverage of the space's native folder — auto-handled: it's just another source type.
- **`move_artifact` fs-aware move** — scope call on whether this rides #192 or becomes its own ticket.
- **`rename_space` primitive** — includes renaming the native folder.
- **`delete_space` filesystem handling** — where do the native folder's files go on deletion.
- **`publish_app` primitive** — promote `spaces/<s>/<app-id>/` → `apps/<app-id>/`.
- **Website + sample-repo renames** — `docs/plugins.html` → `docs/apps.html`; `oyster-sample-plugin` repo → `oyster-sample-app`.
- **Dogfood slash command** — `/register-spec` convenience; the MCP-side description fix lands in this PR.

## Acceptance

- Fresh `npm i -g oyster-os` install creates `~/Oyster/{db,config,apps,backups,spaces}/` and nothing else. `spaces/home/` exists as the default.
- Existing `~/.oyster/userland/` installs migrate cleanly on first startup of the new version; all artifacts still resolve; backup snapshot captured.
- Users browsing `~/Oyster/` can name every top-level folder without help. A user looking for their tokinvest invoice finds `~/Oyster/spaces/tokinvest/invoices/ms-2026-001.md` without Oyster running.
- Agent playbook rule in `.opencode/agents/oyster.md` directs AI-generated content through `create_artifact`; no more drift of homeless content into registered repos.
- `oyster.to` and `oyster-sample-plugin` repo renames filed as follow-up tickets (not gate-blocking).
- CLAUDE.md and `docs/plans/*` reflect the new paths and terminology.
