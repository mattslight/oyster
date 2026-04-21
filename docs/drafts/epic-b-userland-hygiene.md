# Epic B — Userland hygiene

## Goal

Make Oyster's on-disk data **visible**, **organised**, and **portable**. Fix Merlin's confusion about where his stuff lives, fix the grab-bag flat layout that mixes system DBs with user content, and lay groundwork for future sync (Epic C) by storing relative paths under a single base.

## Why now

- **Location confusion (#182):** Merlin couldn't find his workspace — `~/.oyster/` is hidden on every OS, and devs expect their work to live somewhere in their dev folder hierarchy.
- **Layout grab-bag (#172):** `~/.oyster/userland/` mixes system DBs, config, builtins, user content, and orphan files at one level. Users can't tell what's safe to move.
- **Path format blocks portability:** `artifacts.storage_config.path` stores absolute paths. Any move breaks every row. Switching to a relative-path-with-base model unblocks sync, migration, and user-chosen userland locations.

## Story list

| # | Story | Effort |
|---|---|---|
| B1 | Decide final layout. Adopt #172's proposed shape: `~/Oyster/{db,config,spaces,plugins,backups}/` with `userland/` level dropped. Commit the decision in a short spec. | 1h |
| B2 | Decide final location. Probably `~/Oyster/` (visible, per-OS equivalent) vs first-run prompt. Pick one, document, move on. | 30m |
| B3 | Introduce `OYSTER_BASE` — a single env/config var the server resolves. All file reads/writes go through this base. | 1h |
| B4 | Rewrite `storage_config` to store **relative** paths (e.g. `spaces/home/brief.md` instead of `/Users/matt/.oyster/userland/blunderfixer-project-brief.md`). Resolve against `OYSTER_BASE` at read time. | 2–3h |
| B5 | Update all server writers (`artifact-store`, `space-store`, scanner, builtins loader) to produce new layout + relative paths. | 3–4h |
| B6 | One-time migration script (throwaway). `node scripts/migrate-0.4.mjs` moves `~/.oyster/userland/*` → new structure, rewrites DB rows to relative paths, updates `OYSTER_BASE`. No rollback, no auto-detect, no polish. Runs once per user (matt/Bharat/Merlin). Instructions in release notes. | 2h |
| B7 | Update `CLAUDE.md`, `README.md`, docs/index.html, and any CLI help text referencing the old layout. | 1h |
| B8 | Handle `~/Oyster/` as a visible folder on Windows + Linux. macOS no-op. | 30m |

## Dependencies / consumes

- Closes #172, #182
- Provides foundation for Epic C sync (relative paths make replication trivial)
- Coordinate with Epic A: if we ship B before A, the checklist's "where your workspace lives" hint reflects new location.

## Risk — path leakage

B4 + B5 look small on paper. They are not. Path assumptions leak everywhere: scanner writes, builtin loader, import flows, backup paths, icon paths, log paths, test fixtures. The real failure mode isn't the migration script — it's missing one writer that still emits an absolute path after the change.

Mitigations:

- Grep pass before coding: enumerate every call that touches the filesystem (`fs.writeFile`, `fs.mkdir`, `path.join(HOME, ...)`, hardcoded `.oyster` strings). Produce a checklist. Tick off each one.
- Unit test: mock `OYSTER_BASE`, assert no code path returns a string starting with `/` or `C:\` from any `storage_config.path`.
- Smoke test: after migration on matt's install first, exercise every artifact type (create, read, update, open, remove) before touching Bharat/Merlin.
- Treat `0.4.0` as a **genuine breaking-shape release** even with only three users. Don't ship on a day we can't hotfix.

## Launch gate

Ship as `0.4.0-beta.0` (minor bump because it's a breaking layout change). Run migration on matt/Bharat/Merlin installs. If all three load clean and their existing artifacts are intact, promote to `0.4.0`.

## Order with Epic A

Two options:

- **A then B:** ship onboarding on `0.3.x`, then layout change as `0.4.0`. Two releases, cleaner story, but Reddit post goes out on the old layout.
- **A + B together:** bundle as `0.4.0` with new onboarding AND new layout. One release. More moving parts.

Lean A-first — the Reddit thread doesn't hinge on where files live. B can ship the week after.

## Out of scope

- Multi-userland per project root (speculation)
- Import/export of a whole userland (belongs in Epic C)
- Dropbox/iCloud sync of the userland folder (belongs in Epic C)

## Estimate

- All stories: ~11–13h focused work
- End-to-end including testing on all 3 installs: 2–3 days after Epic A lands
