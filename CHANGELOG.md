# Changelog

All notable changes to Oyster are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-05-02

Trustworthy recall — make every memory traceable, every conversation searchable. R6 (traceable recall) and R2 same-device verbatim, both delivered.

### Added

- **Find within a session.** Press Cmd+F with the session inspector open and a search bar appears above the transcript. Type a phrase, see every match highlighted in place; ↑/↓ (or Enter / Shift+Enter) walks through them with the current match scrolled into view. Robust against punctuation FTS5 strips — literal `0.6.0` and `memory_recalls` work. Esc closes. ([#332](https://github.com/mattslight/oyster/issues/332))
- **Spotlight searches transcripts too.** Open Cmd+K (or Ctrl+K) and the dropdown now surfaces matching transcript turns alongside artefacts — type any phrase from a past conversation and it'll find the exact moment, with the matched terms highlighted. Click through to open the source session inspector at that exact turn with the find bar pre-populated. Same FTS5 backend that powers `mcp__oyster__recall_transcripts`, just exposed to the keyboard. ([#329](https://github.com/mattslight/oyster/issues/329))
- **Verbatim transcript recall.** Ask your agent *"what FTS5 schema did we settle on?"* or *"what did Bharat say about memory sync?"* and it now searches your past conversations directly, not just the memory layer. Same-device, full-text indexed via SQLite FTS5; the agent picks the right tool by intent (gist → `recall`; exact phrasing → `recall_transcripts`). Cross-device verbatim recall comes with cloud transcripts in 0.8.0. ([#311](https://github.com/mattslight/oyster/issues/311))
- **Memory tab on the session inspector.** Every session now shows the memories it *wrote* (via `remember`) and the memories it *pulled* (via `recall`). Each entry can click through to the session that originally wrote it, so you can trace any recalled memory back to the conversation that produced it. The Home memories list grows the same affordance — every memory with a known source session has a *from session* button that opens that session's inspector. ([#310](https://github.com/mattslight/oyster/issues/310))
- **Floating scroll-to-bottom arrow** in the session inspector. Appears when you've scrolled materially above the tail; click to snap back to the latest turn and re-arm auto-tail.

## [0.5.0] - 2026-05-01

The 0.5.0 line is now stable. Code is identical to `0.5.0-beta.2`. Headline changes from the beta cycle:

- **Oyster sees your Claude Code sessions automatically.** Run `claude` in any folder mapped to a space and Oyster picks the session up — no MCP wiring, no setup. Title from your first prompt, file reads/edits attributed back to artefact tiles, sessions in unregistered folders land as orphans rather than being dropped. ([#251](https://github.com/mattslight/oyster/issues/251))
- **Session inspector with live transcript.** Click a session and a slide-panel opens with the running transcript, the artefacts the agent touched, and a *Copy resume command* button to pick the conversation back up in your terminal. Scroll near the top of long transcripts and the next 1000 older turns prepend in place — your scroll position stays pinned. Older sessions whose `claude` process finished before Oyster started watching now backfill their transcripts on boot. ([#253](https://github.com/mattslight/oyster/issues/253), [#274](https://github.com/mattslight/oyster/issues/274), [#275](https://github.com/mattslight/oyster/issues/275))
- **Process-aware session states.** Oyster looks at running `claude` processes to tell whether a session is still alive — not just whether the JSONL has been quiet. Long thinking turns no longer flicker into red, and a finished session converges to disconnected within a minute of you closing the terminal.
- **Home as a sectioned feed.** Spaces · Sessions · Artefacts replace the spatial desktop as the default surface. State chips filter sessions inline; filter chips on Artefacts split *mine* / *from agents* / *linked*. Sessions update live as your agents work. ([#252](https://github.com/mattslight/oyster/issues/252), [#280](https://github.com/mattslight/oyster/issues/280))
- **Memories on Home.** Your agents' `remember` notes show up as a section on Home alongside Sessions and Artefacts, scoped by the same space pills. Pick *tokinvest* and you see what each agent learned about that project, not the global pile. ([#254](https://github.com/mattslight/oyster/issues/254))
- **Project tiles on every space.** A row of project tiles sits at the top of any space view — *All*, one tile per linked folder, plus a *scratchpad* tile for native artefacts. Click to scope; **+ Attach folder** opens an inline path input. Promote an orphan folder under Home → Elsewhere into its own space in one click — sessions whose cwd matches re-attribute to the new space. ([#266](https://github.com/mattslight/oyster/issues/266), [#285](https://github.com/mattslight/oyster/issues/285))
- **No more silent empty-shell spaces.** Removing the only folder from a space now deletes the space and sends sessions back to Elsewhere — with a confirm modal that itemises what's affected. Right-click a space pill in the breadcrumb for Rename · Delete; the empty-shell warning ends with `…or delete it.` so you always have a way out. ([#285](https://github.com/mattslight/oyster/issues/285))
- **Oyster Pro foundations.** A new shield-icon pill in the breadcrumb opens a *Coming Soon* page that names what's about to ship — **Sync · Memory · Publish** — and inventories your local `~/Oyster/` (Spaces, Apps, Database rows, Config, Backups). The "Read more" CTA links to a public pricing page at [oyster.to/pricing](https://oyster.to/pricing). *Join the waitlist* captures emails into a Cloudflare D1-backed Worker and confirms via Resend.
- **Local-only endpoints refuse non-loopback callers.** The server now binds to `127.0.0.1` and the Origin guard rejects requests with no Origin from non-loopback addresses. Closes the gap where a non-browser client on the same WiFi could omit `Origin` and pull `/api/vault/inventory`. ([#289](https://github.com/mattslight/oyster/issues/289))

See `0.5.0-beta.0` through `0.5.0-beta.2` below for per-beta detail.

## [0.5.0-beta.2] - 2026-05-01

### Added

- **Pro waitlist signup.** *Join the waitlist* on the pricing page is now wired up — clicking opens a modal, captures an email, and stores it in a Cloudflare D1-backed Worker at `oyster.to/api/waitlist`. Confirmation email goes out via Resend. Worker source + setup steps live in `infra/waitlist-worker/`.

### Changed

- **Sessions default to "all" + table view.** Previously a fresh install showed sessions in icon-grid view filtered to "live", which made fresh installs look empty whenever no Claude session was actively running. Now a new install lands on every session in a list view with state, title, and cwd visible at a glance. Existing users who'd switched to icon view keep their preference.
- **Pricing page hero.** Restructured into two stanzas — Free promise (*"No sign-up. No strings. Yours to keep."*) and a gold-rule Oyster Pro section that names what Pro is and what it adds. Pro is correctly framed as the optional thing (rather than its features).

## [0.5.0-beta.1] - 2026-05-01

### Added

- **Oyster Pro page (in-app + marketing).** A new shield-icon pill in the breadcrumb opens a *Coming Soon* page that names what's about to ship — **Sync · Memory · Publish** — and inventories what's already in your local `~/Oyster/` (Spaces, Apps, Database rows, Config, Backups with newest-snapshot age). The "Read more" CTA links out to a new public pricing page at oyster.to/pricing — Free vs Pro comparison, $20/month, waitlist. Backed by a new `GET /api/vault/inventory` server endpoint that walks the userland tree and queries the SQLite/memory databases for live row counts. Local-origin only.
- **Session inspector.** Click a session tile (or row) and a slide-panel opens with the live transcript, the artefacts the agent touched, and a *Copy resume command* button — paste it in your terminal to pick the conversation back up. Disconnected sessions show a banner with the last heartbeat. Click any artefact to see which sessions touched it, then jump back into one. The transcript updates live as the agent works. ([#253](https://github.com/mattslight/oyster/issues/253))
- **Scroll up to load older transcript turns.** The session inspector loads the latest 1000 turns by default and shows a `1000+` badge when there's more behind them. Scroll near the top of the transcript and the next 1000 older turns prepend in place — your scroll position stays pinned to the same turn so you don't lose your place. Live updates still append to the bottom as the agent works. ([#274](https://github.com/mattslight/oyster/issues/274))
- **Memories on Home.** Your agents' `remember` notes now show up as a section on Home alongside Sessions and Artefacts. The space pills scope all three together — pick *tokinvest* and you see what each agent learned about that project, not the global pile. Orphan memories (no space attached) live under *Elsewhere*. ([#254](https://github.com/mattslight/oyster/issues/254))
- **Project tiles on every space.** A row of project tiles sits at the top of any space view — same visual primitive as Home's space cards. **All** is the default scope (combined session counts); each linked folder gets its own tile with its artefact count; a **scratchpad** tile collects native artefacts (manual + AI-generated) that didn't come from a linked folder. Click any tile to scope Artefacts to that project · click again to clear. Hover a linked tile and a `⋯` button appears top-right with a Detach action. **+ Attach folder** tile opens an inline path input. Spaces with zero folders attached still show a red-tinged warning so the silent-orphan trap stays visible. ([#266](https://github.com/mattslight/oyster/issues/266))
- **Filter and collapse Artefacts on Home.** A 224-tile pile is hard to scan, so the Artefacts section now shows roughly three rows by default with *Show all N* to expand. New filter chips next to the heading split the list by where each artefact came from — *mine* (you created it), *from agents* (your AI did), or *linked* (came in via a folder scan). Selection resets when you change space so each space starts compact and at *all*. ([#280](https://github.com/mattslight/oyster/issues/280))
- **Promote an Elsewhere folder to its own space — one click.** Hover any orphan project tile on Home → Elsewhere and a `＋folder` button appears top-right. Click it and Oyster creates a new space named after the folder, attaches the folder as its source, and re-attributes existing sessions whose cwd matches — so the folder's history follows it into its new space instead of staying stuck in Elsewhere. ([#285](https://github.com/mattslight/oyster/issues/285))
- **Removing the only folder from a space deletes the space.** Detach used to leave the original space behind as an empty shell with sessions stuck pointing at a soft-deleted source — visible in the chip count, hidden behind every filter, unreachable. The folder-tile menu is now *Remove folder*, and the confirm modal explains the consequences honestly: on a multi-folder space it's a normal detach, on the only folder it deletes the space and sends sessions back to Elsewhere. ([#285](https://github.com/mattslight/oyster/issues/285))
- **Empty-shell space surfaces a delete affordance.** The red "no folders attached to this space" banner now ends with `…or delete it.` — clicks open a confirm modal that names how many sessions are stuck inside and that they'll move back to Elsewhere. Closes the only path that left users with an unreachable space (post-detach) and no UI to escape.
- **Right-click a space pill for Rename · Delete.** The context menu that used to live on the (now-removed) chat-bar pills moved to the breadcrumb. *Delete* opens a confirm that itemises how many sessions, artefacts, and memories are in the targeted space and where each lands (sessions and memories revert to Elsewhere; artefacts move to Home grouped under the space's display name). Works on any non-meta pill, regardless of whether the space has folders attached.

### Changed

- **Session states are now process-aware.** Oyster looks at the running `claude` processes on your machine to tell whether a session is still alive — not just whether the JSONL file has been quiet. New states: **active** (green, "updated recently"), **waiting** (amber, "process still open"), **disconnected** (red, "no running process found"), and **done** (grey, "inactive for 24h"). Long thinking turns no longer flicker into red, and a finished session converges to disconnected within a minute or so of you closing the terminal (active window plus the next heartbeat tick).

### Fixed

- **Older sessions now show their transcripts.** Sessions whose `claude` process finished before Oyster started watching used to land with empty transcripts in the inspector — Oyster only ingested events appended after it was running. The watcher now backfills events from each JSONL on boot scan, so existing sessions show their full transcript on the next server restart. Idempotent across restarts. ([#275](https://github.com/mattslight/oyster/issues/275))
- **`?limit=N` on the events endpoint was silently ignored.** The route regex `$`-anchored before the query string so the parameter never reached the handler — the inspector always got the default 1000. Fixed as part of #274.

### Security

- **Local-only endpoints now refuse non-loopback callers.** The Oyster server used to listen on every network interface and rely on the HTTP `Origin` header alone to gate access — fine against a browser tab on `evil.com`, but a non-browser client on the same WiFi could omit `Origin` and pull `/api/vault/inventory`, `/api/memories`, etc. The server now binds to `127.0.0.1` *and* the Origin guard rejects requests with no Origin from non-loopback addresses (belt and braces). ([#289](https://github.com/mattslight/oyster/issues/289))

## [0.5.0-beta.0] - 2026-04-28

### Added

- **Oyster sees your claude-code sessions.** When you run `claude` in any folder mapped to a space, Oyster now picks the session up automatically — no setup, no MCP wiring. The session shows as *running* / *disconnected* on the home feed, with title pulled from your first prompt and tracked file reads/edits attributed back to their tiles. Sessions started in unregistered folders land as orphans rather than being dropped. ([#251](https://github.com/mattslight/oyster/issues/251))
- **Home is now a sectioned feed.** Spaces · Sessions · Artefacts replace the spatial desktop as the default surface. The chat-bar pills scope all sections at once — pick a space and the sessions and artefacts list reflects it. State chips (Running / Awaiting / Disconnected / Done) filter the session list inline. Sessions update live as your agents work — no refresh needed. ([#252](https://github.com/mattslight/oyster/issues/252))

## [0.4.0] - 2026-04-28

The 0.4.0 line is now stable. Code is identical to `0.4.0-beta.8`. Headline changes from the beta cycle:

- **Agent-led setup.** Connect your AI, ask *"Set up Oyster"*, and your agent audits your filesystem and proposes spaces. Works through Claude Code, Cursor, Windsurf, VS Code, or Oyster's own chat bar. ([#184](https://github.com/mattslight/oyster/issues/184), [#195](https://github.com/mattslight/oyster/pull/195))
- **Visible workspace at `~/Oyster/`** with typed sub-folders — `db/`, `apps/`, `spaces/`, `backups/`. Browsable outside Oyster. ([#207](https://github.com/mattslight/oyster/issues/207))
- **Linked folders are first-class.** Attach external folders to a space; detach removes their tiles cleanly; reattach restores them. The ↗ glyph and *Where do my files live?* tile make it obvious which tiles you own vs which are windows into folders elsewhere on disk. ([#208](https://github.com/mattslight/oyster/issues/208), [#220](https://github.com/mattslight/oyster/issues/220))
- **Cloud-AI memory import.** Bring context across from another AI by pasting Oyster's export prompt — spaces, summaries, and memories seed in one pass.
- **Logical-only spaces.** Create a conceptual space first; attach folders later or keep it folder-less.
- **HTML-styled documents render as designed** (invoices, decks, letters), no longer forced through the dark markdown wrapper.
- **Windows polish.** Coloured startup banner, slim dark scrollbars, opencode subprocess no longer leaks across crashes.
- **Better AI error surfacing.** Provider failures (expired key, rate limit, outage) raise a banner with the reason and reconnect command instead of staying silent.

See `0.4.0-beta.0` through `0.4.0-beta.8` below for per-beta detail.

## [0.4.0-beta.8] - 2026-04-28

### Fixed

- **First-run hero tagline no longer overlays the chat output.** Clicking the *Set up Oyster* prompt pill (instead of typing into the input) used to send the message without focusing the chat, so the *"Welcome to your surface."* tagline stayed on screen and floated over the streaming reply. The tagline now hides as soon as any chat message exists. ([#235](https://github.com/mattslight/oyster/pull/235))
- **Space pickers now show your renamed name.** The `#` and `/s` autocompletes used to label every space by its slug (`sample-dashboard`), so renaming *Sample Dashboard* → *Project X* still showed `sample-dashboard` in the picker. They now show the display name; the slug appears as a secondary hint. ([#236](https://github.com/mattslight/oyster/pull/236))

## [0.4.0-beta.7] - 2026-04-25

### Changed

- **"Where do my files live?" tile is more useful at a glance.** Adopts the Quick Start visual language, leads with the resolved path of your Oyster home, and shows a small preview of the chain-link marker so you can see what a linked tile looks like — not just be told. ([#222](https://github.com/mattslight/oyster/pull/222))

## [0.4.0-beta.6] - 2026-04-25

### Changed

- **Linked tiles now carry a small chain-link marker** (bottom-left of the icon) so you can tell at a glance which tiles are windows into folders elsewhere on disk vs. native to your Oyster workspace. Hover the marker for the source folder name. The "Where are my files?" tile is now **"Where do my files live?"** and explains the two homes — Oyster-managed workspace, and linked folders you own. ([#220](https://github.com/mattslight/oyster/issues/220))

## [0.4.0-beta.5] - 2026-04-25

### Changed

- **Linked folders are now first-class.** Detaching a folder from a space cleanly removes its tiles (no more orphans), and reattaching the same folder restores them. Sets up cleaner provenance and detach UI later.

## [0.4.0-beta.4] - 2026-04-25

### Changed

- **Startup banner is now a coloured box** so the "Open Oyster" URL and starter prompts don't get lost in the logs.

### Fixed

- **Setup dock no longer skips "Connect your AI"** after the chat bar creates your first space.

## [0.4.0-beta.3] - 2026-04-24

### Changed

- **Clearer first-run hero.** *"Welcome to your surface. Ask: `Set up Oyster`"* — tap the prompt pill to send it, or type your own.

### Fixed

- **Windows polish.** Cleaner startup (no more alarming error messages in the terminal), thin dark scrollbars on artifacts and setup dialogs to match Mac, and the built-in terminal now recognises Oyster as an AI agent option.

## [0.4.0-beta.2] - 2026-04-24

### Fixed

- **`oyster install <id>` now works.** The CLI was writing to the pre-0.4 hidden workspace path while the server scans the new `~/Oyster/apps/` — so installs silently landed where nothing looked. Community plugins now install and appear on the surface after a restart. ([#212](https://github.com/mattslight/oyster/pull/212))

## [0.4.0-beta.1] - 2026-04-24

### Added

- **"Where are my files?" tile.** Shows your live workspace paths, not a generic doc. ([#207](https://github.com/mattslight/oyster/issues/207))
- **Archive shortcut** — icon bottom-left opens the archived view. ([#207](https://github.com/mattslight/oyster/issues/207))
- **Right-click → Regenerate icon** on any tile, including builtins. ([#207](https://github.com/mattslight/oyster/issues/207))
- **Agent can list and restore archived artifacts.** Previously it couldn't see them. ([#207](https://github.com/mattslight/oyster/issues/207))

### Changed

- **Workspace moves to `~/Oyster/`** (from hidden `~/.oyster/userland/`). Visible in Finder / Explorer, with clear sub-folders: `db/`, `apps/`, `spaces/<project>/`, `backups/`. Your content is browsable outside Oyster. ([#207](https://github.com/mattslight/oyster/issues/207))
- **Styled confirm / rename dialogs** replace the default browser prompts for uninstall, archive, and folder rename. ([#207](https://github.com/mattslight/oyster/issues/207))
- **"Import from AI" → "Import Memories"** — same tile, clearer name. ([#207](https://github.com/mattslight/oyster/issues/207))

### Fixed

- **Your AI can now create HTML-styled documents (invoices, receipts, letters).** Agents can save artifacts as HTML so they render on the surface the way they were designed — white paper, printable layout. Previously every agent-created notes artifact was forced into markdown and shown through the dark markdown wrapper, so pages meant for white paper looked wrong.
- **Silent AI failures now surface.** When your AI provider rejects a message (expired key, rate limit, provider outage) Oyster shows a banner with the reason and, for auth failures, the exact command to reconnect — instead of the chat bar staying mute. ([#201](https://github.com/mattslight/oyster/issues/201))
- **AI engine no longer piles up after crashes or force-quits.** Previous Oyster sessions that died without a clean shutdown used to leave their AI engine subprocess running forever, and across days of use these could stack up and fill your swap. Oyster now reaps any orphaned engines on startup, and uses OS-level process groups so a graceful shutdown kills the whole engine tree in one go. ([#191](https://github.com/mattslight/oyster/issues/191))
- **Silent "thinking…" hang when no AI provider is configured.** Some AI-engine failures only surfaced in the server log and never reached the chat — messages would sit on "thinking…" forever. Oyster now catches those and raises them into the same banner as other AI errors, so you always get a reason and a next step. ([#203](https://github.com/mattslight/oyster/issues/203))

## [0.4.0-beta.0] - 2026-04-23

### Added

- **Onboarding pill.** A persistent setup companion in the top-right of a fresh Oyster walks you through three steps: connect your AI agent, ask it to set things up, and optionally import memories from another AI. Progress tracks automatically as you go. ([#184](https://github.com/mattslight/oyster/issues/184))
- **Agent-led discovery.** Connect Claude Code, Cursor, Windsurf, VS Code — or use Oyster's own chat bar — and ask *"set up Oyster for me."* Your agent audits your filesystem, proposes a set of spaces in chat, and creates them once you confirm.
- **Cloud-AI import.** Bring your context across from another AI: copy Oyster's import prompt into ChatGPT or Claude, paste the response back into Oyster's chat, and your spaces, summaries, and memories are seeded in one pass.
- **Logical-only spaces.** Spaces no longer need a folder on disk. Create a conceptual space ("Work", "Reading") first; attach folders later, or keep it purely for memories and artifacts.

### Changed

- **Safer imports.** When Oyster asks another AI to export your context, it now explicitly tells that AI to leave out credentials and third-party personal details — so a raw export can't leak context you wouldn't want on your desktop.
- **Clearer first-run copy.** The hero bar leads with *"Tell your agent to set up Oyster"*, and the connect-your-AI builtin leads with what you get (an agent driving your workspace) rather than protocol terminology.
- **Drag-and-drop onboarding retired for this release.** Onboarding now goes through your agent; post-onboarding drag-drop to add folders later will return in a future release ([#190](https://github.com/mattslight/oyster/issues/190)).

### Fixed

- **Broken icon placeholders** when a generated icon briefly 404s — Oyster now shows the kind glyph and silently retries.
- **Import step stuck on "Loading…"** — an 8-second timeout and a retry button handle slow or failed fetches.
- **Escape closes the onboarding popover** (consistent with other overlays).
- **Cross-origin hardening** on local API endpoints that surface connected-agent activity.

## [0.3.8] - 2026-04-21

### Fixed

- Stopped overriding OpenCode's own model selection with a hardcoded `anthropic/claude-sonnet-4-20250514` string, which broke users authed with OpenAI / Google / other providers (`ProviderModelNotFoundError` → 502 in chat + AI import). OpenCode now picks its default model from whichever provider the user authed with via `opencode providers login` or env vars. ([#174](https://github.com/mattslight/oyster/issues/174))
- Claude Code MCP install command now uses `--scope user` so the Oyster MCP follows the user across every project instead of being pinned to the directory they happened to run `claude mcp add` from. Updated in README, landing page, `oyster.to/mcp`, the in-app "Connect your AI" builtin, and the CLI startup banner. ([#175](https://github.com/mattslight/oyster/issues/175))

## [0.3.7] - 2026-04-20

### Added

- `OYSTER_DEBUG` artifact-lifecycle logging (`OYSTER_DEBUG=1 oyster` or `OYSTER_DEBUG=artifact oyster`) — opt-in structured traces across MCP tool entry, OpenCode file events, watcher decisions, service layer, and reconciliation. No output when unset.

### Fixed

- MCP `create_artifact` and `register_artifact` handlers now `await` the async service calls. Previously the tool response serialised as `{}` and the agent received no artifact id, triggering recovery paths that could duplicate rows.
- `docs/changelog.html` auto-regenerates on pushes to `main` that touch `CHANGELOG.md` or the build script — `oyster.to/changelog` no longer lags between releases.

## [0.3.6] - 2026-04-19

### Fixed

- Windows: artifact appeared as `C:` and hung in `generating` forever. Watcher now uses `path.isAbsolute()` instead of a POSIX-only `startsWith("/")` check.
- Windows: dark-theme scrollbar styling on the chat panel (thin `::-webkit-scrollbar` + Firefox `scrollbar-color`) — macOS unchanged.

## [0.3.5] - 2026-04-19

### Added

- Right-click menu on desktop artifact tiles — Rename (inline), Archive (soft-delete), Uninstall for plugins, read-only label for builtins.
- Right-click menu on folder tiles — Rename folder, Archive folder (bulk), alongside existing Convert to Space.
- `#archived` view — browse soft-deleted artifacts and Restore them.
- Changelog page at `oyster.to/changelog`, generated from `CHANGELOG.md`.
- `oyster --help` shows 🦪 in the header.

### Changed

- Docs site typography: Barlow headings paired with Space Grotesk body across landing and `/plugins`.
- `/plugins` hero renamed to "Pearls".
- Chat-bar Tab now completes the highlighted suggestion instead of executing — press Enter to execute.

### Fixed

- Import resolves spaces by display_name when the slug lookup misses (prevents duplicate spaces when an agent emits a renamed space name).

### Performance

- Grainient shader pauses `requestAnimationFrame` on window blur and tab hide (was pinning the Chrome GPU process while Oyster sat in the background). Time stays continuous on resume — no visual jump.
- Archived-paths lookup cached on `ArtifactService`, invalidated on mutations — `/api/artifacts` polling is now O(active) in steady state.

### Security

- Artifact endpoints (reads and mutations) locked to localhost origins — prevents cross-origin sites from enumerating or mutating the local surface.
- JSON body size capped at 64 KB on mutation routes.

## [0.3.4] - 2026-04-19

### Fixed

- Stale tile icons cleared after `oyster uninstall <id>`.

### Changed

- `/plugins` copy button uses `oyster install <id>` form.

### Chore

- Adopted eslint 10 in web (fixed 16 surfaced errors).
- Dependabot config for Actions and npm groups.
- Release workflow actions bumped for Node 24.
- Dep bumps: `marked` 17 → 18; `@types/node` 22 → 25; web/server/root minor+patch groups.

## [0.3.3] - 2026-04-18

### Added

- **Plugins — Tier 2 installer.** `oyster install <id>`, `oyster uninstall <id>`, `oyster list` install community plugins by id.
- `oyster install <id>` resolves the repo from the `mattslight/oyster-community-plugins` registry.
- New `/plugins` catalog page on oyster.to with copy-install buttons, strict input validation, and a CDN fallback.
- Plugin system design doc.

### Changed

- README and `CLAUDE.md` updated to match shipped v1 — port 4444, 19 MCP tools, FTS5 memory.
- `/plugins` page polish: hairline borders dropped, only purposeful ones kept.

## [0.3.2] - 2026-04-18

### Added

- `--version` / `-v` flag on the `oyster` CLI.

### Fixed

- Chat user bubble no longer conflates visually with the assistant response.

### Chore

- Local discovery validation PoC script.

## [0.3.1] - 2026-04-17

First stable release of the 0.3 line. Bundles everything shipped across the 0.3.0 beta cycle (no stable 0.3.0 tag).

### Added

- **Cloud AI import.** Paste from ChatGPT / Claude / Gemini and Oyster scaffolds projects, context, and memories.
  - 3-step wizard: select provider, paste AI output, preview and import.
  - Server converts any format to structured JSON via OpenCode.
  - Merge-based: detects existing spaces, skips duplicates on re-import.
  - First-run onboarding banner with "Import from AI" CTA.
- **Builtin redesign.** Quick Start, Connect Your AI, and Import from AI built as consistent glass-card builtins with ambient glow, pill selectors, and `postMessage` close support.
- **Space management UI.** Rename, recolour, and remove spaces directly from the UI.

### Fixed

- **Cross-platform (Windows):**
  - Hardcoded `/` path separators replaced with `path.basename` / `path.sep` throughout.
  - Swapped `node-pty` for `@lydell/node-pty` — prebuilt binaries, no build tools required.
  - Auth detection checks `~/.local/share/opencode/auth.json` directly.
  - Windows 403 on artifact serving (path separator mismatch).
- **Stability:**
  - SSE fetch no longer crashes when OpenCode dies mid-stream.
  - OpenCode port defaults to `0` (auto-select); was hardcoded `4096`.
  - Kill OpenCode subprocess on shutdown; reset port on restart.

### Changed

- Terminal WebSocket uses dynamic host instead of hardcoded port 4200.
- Connection banner says "oyster" (was "npm run dev").
- Helpful error when import paste yields nothing.

## [0.2.4] - 2026-04-15

### Added

- Release scripts: `release:minor`, `release:beta`, `release:promote` (later simplified to `release` and `release:beta`).

### Fixed

- Prod backups at `~/oyster-backups/auto/`, dev at `~/oyster-backups/dev/` (were conflating).
- `import-state.json` stored in userland (was shared at `~/.oyster`).
- Import wizard UI polish — prompt copy hint, paste area, consistent CTAs.
- Native `select` replaced with a custom dark-themed dropdown.

## [0.1.21] - 2026-04-14

### Added

- **Auto-backup.** Userland auto-backed up on every startup to `~/oyster-backups/auto/`.
  - One backup per day — repeated restarts reuse the same slot.
  - Rotates to last 5 days of history.
  - Runs before bootstrap/migration — captures pre-upgrade state.
  - Best-effort: never crashes server startup.
- **MCP onboarding.** "Connect your AI" builtin on the home surface with a tabbed guide for Claude Code, Cursor, VS Code, and Windsurf. CLI startup prints the MCP connect command. Landing page at `oyster.to/mcp`.
- **Quick Start guide.** 60-second overview builtin: prompt bar, slash commands, spaces, artifacts.

### Changed

- Landing page MCP section: real client-specific connection snippets with tabs, actual tool-name pills.
- Nav replaced GitHub link with MCP page link.

### Fixed

- Mobile: terminal mockup no longer overflows on small screens.
- "Bring Your Own AI" capitalisation and naming consistency.

## [0.1.17] - 2026-04-13

### Added

- **Drop-to-import.** Drop a folder anywhere on the surface to import projects. Full-page drop zone, Grainient speeds up on drag, icons and chat dim to focus attention, wizard skips straight to scanning.
- **Persistent memory.** AI agent remembers across sessions.
  - `MemoryProvider` interface — async, storage-agnostic, swappable backends.
  - First provider: SQLite FTS5 with full-text search in a separate `memory.db`.
  - 4 MCP tools: `remember`, `recall`, `forget`, `list_memories`.
  - Explicit writes only — agent stores memory when asked.
- **First-run onboarding.** "Drop a folder to get started" hint, space-pill hint, surface-wide folder-drop trigger.
- **Dev / prod separation.** Dev server on port 3333, prod on 4444 — run side by side. Dev uses `./userland`, prod uses `~/.oyster/userland`. Version badge on surface shows version + env.

### Fixed

- Icon resolution checks artifact root dir for `icon.png`.
- `opencode.json` included in npm package.

### Changed

- Input placeholder cycles on blur (was static per session).
- Agent sessions use the `oyster` agent (was defaulting to `build`).
- Port resilience: OpenCode config written dynamically with actual server port; OpenCode spawned after server listens (fixes MCP connection race); Vite proxy reads `OYSTER_PORT` env var.

## [0.1.10] - 2026-04-12

### Added

- **Multi-folder spaces + broader scanner.**
  - A space can have multiple folders (repos, project dirs, any folder).
  - `space_paths` table — migrates existing `repo_path` values automatically.
  - Add Space wizard toggles between "New space" and "Existing space".
  - Drop multiple folders onto one space. API: `GET/POST/DELETE /api/spaces/:id/paths`.
  - Scanner finds artifacts in Go, Rust, Python, Ruby, Java (not just JS). Root-level projects detected. Any `.md` found as notes. More JS frameworks: Angular, Nuxt, Astro, Remix, Solid.
  - Folder resolution searches Dropbox, OneDrive, iCloud Drive, Downloads.
- **CLI packaging — `npm install -g oyster-os`.**
  - Checks for OpenCode auth; runs `opencode providers login` inline on first run (OAuth in browser).
  - Spawns server process, opens browser.
  - Bootstraps `~/.oyster/userland/` with builtins (zombie-horde, the-worlds-your-oyster deck).
  - Handles SIGINT/SIGTERM cleanup.
  - Compiled server + static web serving — package is ~2.2 MB unpacked, 6 runtime dependencies.
  - `node-pty` moved to optionalDependencies with graceful fallback.
  - Windows support: finds `opencode.cmd`, uses `shell: true` for spawn.
  - Path traversal protection on static file serving.

### Changed

- Auth flow: removed API key prompt — runs `opencode providers login` inline on first run.
- Renamed builtin: `snake-game` → `zombie-horde`.
- Documentation overhaul: CLAUDE.md rewritten to match shipped product; design doc updated; README rewrite for npm.
- Landing page polish: terminal window mockup with traffic-light dots; Mac/Windows OS toggle.

## [0.0.x] - Prototype (2026-03-12 through 2026-04-11)

Milestones leading up to the first npm-packaged release, newest first.

#### 2026-04-11 — Phase A: prompt-driven surface control

The chat bar now controls the OS. Dropped Graphiti dependency (memory deferred to v2). Added SSE command channel for instant UI push events.

- MCP tools: `open_artifact(id)`, `switch_space(id)`, `list_artifacts` with search/limit.
- Slash commands: `/s <prefix>` (space switch), `/o <query>` (artifact open) — client-side, no LLM call.
- `#` prefix shortcuts: `#<name>`, `#<digit>`, `#.`, `#0`.
- SSE command channel at `GET /api/ui/events`.
- Tagline: "Apps are dead. Welcome to your surface."
- Landing page (GitHub Pages) with animated mock UI, 3D tilt panels, real FAL icons.

#### 2026-03-30 — View toggle + kind filter polish

- View toggle (grid/list) floats next to the kind filter pill.
- List-view space tags restyled.

#### 2026-03-29 — Spaces as first-class entities

- `spaces` table, SpaceStore, SpaceService. Scanner walks repos up to 4 levels deep.
- HTTP API: `POST/GET/DELETE /api/spaces`, `POST /api/spaces/:id/scan`.
- MCP `onboard_space` — creates space + triggers scan in one call.
- Add Space wizard: 2-step modal with drag-and-drop folder picker.

#### 2026-03-28 — Desktop redesign

- Auto-hide topbar with view toggle, sort modes, kind filter pills, group-by.
- Drag-to-reorder icons in grid view.
- Animated space pills (framer-motion), per-space accent colours.
- Spotlight search (Cmd+K) with fuzzy filter across all artifacts.

#### 2026-03-27 — Oyster MCP surface

Agents (Claude Code, OpenCode, Cursor, etc.) can manage the Oyster surface via MCP.

- Discovery: `get_context`, `list_spaces`, `list_artifacts`.
- Authoring: `create_artifact`, `read_artifact`, `update_artifact`, `register_artifact`.
- Localhost-only (non-local Origin rejected with 403), approved roots, stateless transport.

#### 2026-03-14 — Rebrand + artifact contract + AI icons

- Global rebrand: mint green → electric indigo.
- Artifact contract: every generated output gets a folder, `manifest.json`, and source files under `/artifacts/<id>/`.
- AI-generated artifact icons — GPT-4o-mini + fal.ai Flux Schnell render geometric icons per artifact.
- Showcase deck: "The World's Your Oyster" redesign with GSAP scroll-driven reveal.

#### 2026-03-13 — Sprint 2: wire the engine

- OpenCode terminal embedded (xterm.js + WebSocket PTY).
- HTTP+WS hybrid server with app process management.
- Space-based navigation, deck artifacts, chat API with SSE streaming.

#### 2026-03-12 — Sprint 1: UI mockup

- Surface with Aurora WebGL animated background.
- Typed artifact icons, chat bar, window system with viewer.

[Unreleased]: https://github.com/mattslight/oyster/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/mattslight/oyster/compare/v0.5.0-beta.2...v0.5.0
[0.5.0-beta.2]: https://github.com/mattslight/oyster/compare/v0.5.0-beta.1...v0.5.0-beta.2
[0.5.0-beta.1]: https://github.com/mattslight/oyster/compare/v0.5.0-beta.0...v0.5.0-beta.1
[0.5.0-beta.0]: https://github.com/mattslight/oyster/compare/v0.4.0...v0.5.0-beta.0
[0.4.0]: https://github.com/mattslight/oyster/compare/v0.4.0-beta.8...v0.4.0
[0.4.0-beta.8]: https://github.com/mattslight/oyster/compare/v0.4.0-beta.7...v0.4.0-beta.8
[0.4.0-beta.7]: https://github.com/mattslight/oyster/compare/v0.4.0-beta.6...v0.4.0-beta.7
[0.4.0-beta.6]: https://github.com/mattslight/oyster/compare/v0.4.0-beta.5...v0.4.0-beta.6
[0.4.0-beta.5]: https://github.com/mattslight/oyster/compare/v0.4.0-beta.4...v0.4.0-beta.5
[0.4.0-beta.4]: https://github.com/mattslight/oyster/compare/v0.4.0-beta.3...v0.4.0-beta.4
[0.4.0-beta.3]: https://github.com/mattslight/oyster/compare/v0.4.0-beta.2...v0.4.0-beta.3
[0.4.0-beta.2]: https://github.com/mattslight/oyster/compare/v0.4.0-beta.1...v0.4.0-beta.2
[0.4.0-beta.1]: https://github.com/mattslight/oyster/compare/v0.4.0-beta.0...v0.4.0-beta.1
[0.4.0-beta.0]: https://github.com/mattslight/oyster/compare/v0.3.8...v0.4.0-beta.0
[0.3.5]: https://github.com/mattslight/oyster/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/mattslight/oyster/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/mattslight/oyster/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/mattslight/oyster/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/mattslight/oyster/compare/v0.2.4...v0.3.1
[0.2.4]: https://github.com/mattslight/oyster/compare/v0.1.21...v0.2.4
[0.1.21]: https://github.com/mattslight/oyster/compare/v0.1.17...v0.1.21
[0.1.17]: https://github.com/mattslight/oyster/compare/v0.1.10...v0.1.17
[0.1.10]: https://github.com/mattslight/oyster/releases/tag/v0.1.10
