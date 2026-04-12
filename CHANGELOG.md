# Changelog

## 2026-04-12

### Phase B: CLI packaging — `npm install -g oyster-os`

Oyster is now a published npm package. One command to install, one command to run.

**CLI entry point (`bin/oyster.mjs`)**
- Checks for API keys (Anthropic, OpenAI, Gemini, Groq); prompts on first run and saves to `~/.oyster/.env`
- Auto-detects provider from key prefix (sk-ant → Anthropic, sk- → OpenAI, etc.)
- Spawns server process, opens browser to `http://localhost:4200`
- Bootstraps `~/.oyster/userland/` with builtins (snake-game, the-worlds-your-oyster deck)
- Handles SIGINT/SIGTERM cleanup

**Compiled server + static web serving**
- Server compiles to JS via tsc (no tsx at runtime)
- Web build copied into `server/dist/public/` — one runtime root, one port
- Package is ~2.2 MB unpacked, 6 runtime dependencies
- `node-pty` moved to optionalDependencies with graceful fallback when unavailable

**Cross-platform**
- Windows support: finds `opencode.cmd`, uses `shell: true` for spawn on win32
- Path traversal protection on static file serving
- Userland defaults to `~/.oyster/userland/` (writable), not package dir

### Documentation overhaul

- CLAUDE.md rewritten to match shipped product — one server on 4200, OpenCode internal, `~/.oyster/userland/`, npm workflow
- Design doc updated: architecture diagrams show OpenCode as internal subprocess, Graphiti deferred to v2
- `opencode.json` model fixed to `anthropic/claude-sonnet-4-20250514`
- README rewrite for npm — quick start is `npm install -g oyster-os`, not `git clone`; full loop from install to MCP to onboard

### Landing page polish

- Terminal window mockup with traffic light dots for `npm install` section
- Mac/Windows OS toggle with pill-shaped sliding active state
- `npx oyster-os` alternative with gold "no install?" note
- Feature sections reordered: surface first, then navigate, then get started

## 2026-04-11

### Phase A: prompt-driven surface control + slash commands

The chat bar now controls the OS. Dropped Graphiti dependency (memory deferred to v2), added SSE command channel for instant UI push events.

**New MCP tools**
- `open_artifact(id)` — opens viewer via SSE push, instant
- `switch_space(id)` — navigates desktop via SSE push, instant
- `list_artifacts` gains `search` and `limit` params for LLM-based resolution

**Slash commands (client-side, no LLM call)**
- `/s <prefix>` — instant space switch with subsequence matching
- `/o <query>` — token-scored artifact open with autocomplete dropdown
- Autocomplete on `/` with keyboard nav (↑↓ Enter Tab Escape)
- Messages panel dims when autocomplete is open

**# prefix shortcuts**
- `#<name>` — space switch (Enter to confirm)
- `#<digit>` — instant space switch (no Enter needed)
- `#.` = home (like `cd .`), `#0` = all
- "No match" feedback for unmatched `#` commands
- Auto-focus chat input on any keypress

**SSE command channel**
- `GET /api/ui/events` — server pushes `open_artifact`, `switch_space`, `artifact.created` events
- React subscribes on mount; viewer and desktop respond to push commands instantly

**Bug fixes**
- `source_origin` threaded through artifact creation
- Artifact kind inference improvements
- Stale closures fixed in ChatBar (missing `useCallback` deps)
- Duplicated scoring logic extracted to shared `scoreArtifacts()` function
- Silent failures on unmatched commands now show feedback

### UX polish — connection banner, tagline, alignment toggle

- Red glassmorphic connection banner with pulsing dot when server is unreachable
- Tagline changed to "Apps are dead. Welcome to your surface."
- Alignment toggle (left/center/right) available on all spaces, not just __all__
- Agent instructions updated: navigation commands are instant, no deliberation
- Dev port changed from 5555 to 7337

### Landing page — full marketing site

Built a GitHub Pages landing page with interactive mock UI:

- Hero section with animated typing, space switching, and build progress
- 3D tilt effect on mock panels (follows mouse cursor)
- Real FAL-generated artifact icons
- "Import your projects" section showing repo onboarding scan results
- "Bring your own AI" section — MCP as a feature, tool names as pills (open, create, organise, search, navigate, import)
- "UI that adapts to the job" section — dynamic UI carousel (kanban/chart/list cycling) with Coming Soon ribbon
- "From zero to workspace in one command" — `npm install` section with animated space pills
- Subtitle: "A modern workspace OS with AI at its core"
- Space Grotesk + IBM Plex Mono typography
- Bottom CTAs and footer

## 2026-03-30

### View toggle — always visible alongside kind filter

- View toggle (grid/list) now floats next to the kind filter pill instead of being replaced by it
- Filter pill simplified: "Showing" label removed — just `APPS ▾ ✕`
- Toggle and pill share a `.filter-bar` flex wrapper, centered at the top of the surface
- Kind switcher dropdown (▾) only shown when multiple kinds exist in the space
- Fixed bug: clicking a kind option in the dropdown had no effect — `pointerdown` outside-click handler was unmounting the dropdown before the `click` could fire; fixed by stopping propagation on dropdown option `pointerdown`

### Spaces hierarchy + list view polish

- `parent_id` column added to spaces table for UI navigation hierarchy (nullable, top-level spaces are NULL)
- List view space tags restyled: solid tinted background, soft white text, lighter font weight

## 2026-03-29

### Add Space — spaces as first-class entities with wizard, scanner, and MCP tool

**Spaces table + provenance**
- New `spaces` table in SQLite with display name, repo path, colour, scan status, and timestamps
- Artifact table extended with `source_origin` (`manual` | `discovered`) and `source_ref` (e.g. `web/:app`, `README.md:notes`) for deterministic rescan identity
- DB seeded from existing artifact `space_id` values on first startup; guard prevents resurrection of deleted spaces on restart

**SpaceStore + SpaceService**
- `SqliteSpaceStore`: CRUD for spaces with atomic updates
- `SpaceService`: `createSpace`, `listSpaces`, `getSpace`, `deleteSpace` (cascades artifacts), `scanSpace`
- Scanner walks repo up to 4 levels deep, detects apps (via `package.json` + framework keywords), notes (README, CHANGELOG, `docs/**/*.md`), and diagrams (`.mmd`, `.mermaid`)
- Auto-groups by top-level directory: `Apps`, `Docs`, etc.; root files ungrouped

**HTTP API**
- `POST /api/spaces` — create space
- `GET /api/spaces` — list spaces
- `GET /api/spaces/:id` — get space
- `DELETE /api/spaces/:id` — delete space (cascades artifacts)
- `POST /api/spaces/:id/scan` — trigger scan, returns `ScanResult`
- `GET /api/resolve-folder?name=` — resolves folder name to absolute path by searching common dev directories; deduplicates by inode to handle macOS case-insensitive filesystem

**MCP `onboard_space` tool**
- Creates space + triggers scan in one call
- Returns `space_id` and `scan_summary` with discovered/skipped/resurfaced counts
- `list_spaces` updated to read from `SpaceStore` (returns full `Space` objects with colour, scanStatus, etc.)

**Add Space wizard (UI)**
- 2-step modal: (1) name input + drag-and-drop folder picker → (2) scan results
- Drag-and-drop uses `webkitGetAsEntry()` — no permission prompt, no file scanning; folder name sent to `/api/resolve-folder` for path resolution
- 3-bar stepper (`— — —`) at top; step 3 dimmed (AI generation, not yet implemented)
- Scan results show apps and docs in separate sections with dot indicators
- Rollback: if scan fails, the space row is deleted so the user can retry with the same name
- `+` pill in ChatBar opens the wizard

**Bug fixes + polish**
- `getDocFile()` fixed to return storage path for `local_process` artifacts (not just `static_file`) — unblocks icon regeneration for external repo apps
- Icon regeneration for artifacts outside userland now stores icons in `userland/icons/<id>/`
- Space pill `+` button: low opacity, brightens on hover

### Desktop toggle — etched into surface

- View toggle (grid/list) restyled from frosted glass card to a sunken/recessed appearance
- Container: inset box-shadow, no backdrop blur — looks carved into the desktop surface
- Inactive icons: 22% white opacity (present but unobtrusive)
- Active state: slight lift with drop shadow, 65% white (clearly active, no purple glow)

### Specs + planning

- Design spec: `docs/superpowers/specs/2026-03-29-oyster-folder-design.md` — `.oyster/` repo-carried project config for team sharing (Option C: overrides only, keyed by `source_ref`, merge on rescan)
- GitHub issues: #31 `.oyster/` folder, #32 Add Space via MCP parity, #33 wizard step 3 AI generation

## 2026-03-28

### Desktop polish — floating toggle, filter notice, list headers, icon centering

**Floating view toggle + filter notice**
- View toggle (grid/list) moved out of the auto-hide topbar to a persistent pill floating centered at the top of the desktop
- When a kind filter is active, the toggle is replaced by a filter notice: "Showing APPS ▾ ✕"
- Clicking the kind label opens a dropdown to switch to another kind directly
- ✕ clears the filter and restores the view toggle

**List column headers**
- Name and Kind headers sit above their respective columns
- Clicking a header sorts by that column; clicking again toggles asc/desc direction (↑/↓)
- Sort direction persisted to localStorage
- Section headers aligned above the Name column (not the dot)

**Group-by none**
- "none" added to the group-by control in all-space view — shows a flat unsectioned grid or list

**Layout fixes**
- Icon grid centered horizontally (`auto-fit` columns + `justify-content: center`; was `auto-fill` which kept icons left-aligned)
- Scroll restored — `height: 100%` changed to `min-height: 100%` on the icon grid
- Topbar controls centered (`justify-content: center`)
- Hero fade starts earlier (18%→38%) to clear the centered chatbar; normal fade extended for taller chatbar clearance

### Desktop redesign — topbar, sort/filter, drag-to-reorder, animated space pills, spotlight search

**Desktop topbar (auto-hide)**
- Topbar fades out after 2s of inactivity; hover top edge to reveal
- View toggle: grid / list (persisted to localStorage globally)
- Sort modes: A–Z, by kind, timeline (per-space localStorage)
- Kind filter pills: show all or a specific artifact kind
- Group-by (all-space only): by space or by kind
- Clock component removed; topbar supersedes it

**Drag-to-reorder**
- Icons can be dragged to any position in grid view
- Order persisted per-space in localStorage
- Drag only active in A–Z sort mode (other modes have deterministic order)

**Animated space pills**
- Home icon pill, All pill, named space pills
- Shared layout animation (framer-motion) for sliding active indicator
- Per-space accent colors from a curated palette via `spaceColor` utility
- Active pill text is white; `LayoutGroup` scopes animation to this pill group

**Spotlight search (Cmd+K)**
- Fuzzy label filter across all artifacts
- Shows kind badge and space label per result
- Keyboard nav (↑↓ Enter) and Escape to dismiss

**Bug fixes**
- Content top-padding increased from 24px to 60px across grid, all-grid, and list views — was hidden behind the 48px topbar
- Space pill active text color set to white via `.space-pill.active` class

## 2026-03-27

### Oyster MCP — agent-facing tool surface

Agents (Claude Code, OpenCode, Cursor, etc.) can now manage the Oyster desktop surface programmatically via MCP at `http://localhost:4200/mcp/`.

**Discovery tools**
- `get_context` — returns a full description of Oyster OS, artifact kinds, runtime model, and the actual userland path. Automatically called by fresh agent sessions.
- `list_spaces` — lists all spaces with artifact counts
- `list_artifacts` — lists all artifacts with id, label, kind, space, status, url, group, and source_path

**Authoring tools**
- `create_artifact` — writes a new file inside userland and registers it on the desktop in one step. Server computes the path from space + label; agent provides content. IDs are opaque UUIDs (not tied to filename or space), so the same label can exist in multiple spaces or subdirectories without collision. Exclusive write (`flag: wx`) + best-effort rollback prevents orphan files.
- `read_artifact` — returns raw text content of static file artifacts (.md, .html, .mmd, .txt, .json, .csv)
- `update_artifact` — updates display metadata only (label, space, group). Does not move or rename files. Space assignment is desktop metadata — the file stays where it is.
- `register_artifact` — registers a pre-existing file on disk as a desktop artifact (legacy flow; prefer `create_artifact` for new content)

**Design decisions recorded**
- Stateless transport: fresh McpServer + fresh StreamableHTTPServerTransport per request
- Localhost-only: non-local Origin headers rejected with 403
- Approved roots: `register_artifact` only accepts paths under userland/
- Spaces are emergent: no spaces table, derived from artifact space_id
- Generated artifacts (`gen:` prefix) are in-memory only and cannot yet be updated via MCP — this is a known gap (Phase 3: `promote_artifact`)

**Agent onboarding**
- `opencode.json` updated with `oyster` MCP entry pointing to `localhost:4200/mcp/`
- `.opencode/agents/oyster.md` updated with full tool table and usage guidance
- Fresh-session test confirmed: agent called `get_context` proactively, surfaced userland path, understood spaces-are-emergent model

## 2026-03-14 (night)

### AI-generated artifact icons

- Geometric icon generation pipeline: GPT-4o-mini reads app source code and crafts art-directed prompts, fal.ai Flux Schnell renders 512x512 geometric/low-poly icons
- Icons use the desktop colour palette per artifact type (matching typeConfig gradients and accent colours)
- Sequential job queue processes icons one at a time, skips if icon.png already exists on disk
- Existing icons detected from disk on server restart (no re-generation)
- Graceful degradation: no FAL_KEY disables icons entirely, no OPENAI_API_KEY falls back to basic prompts
- Frontend renders AI icons with CSS border-radius clipping, falls back to SVG type icons
- `@fal-ai/client` dependency added, env vars loaded via `node --env-file`

### Fixes

- Doc viewer "Not found" — `/docs/:name` route now strips query params (cache-bust `?t=` was breaking the regex)
- Tagline: "Tools are dead. Welcome to the surface."
- Ultra Hardcore popup: "This opens the shell." with white button text

## 2026-03-14 (evening)

### Global rebrand: mint green to electric blue/indigo

- Accent colour changed from #21b981 (mint green) to #7c6bff (electric indigo) across all surfaces
- Aurora background gradient updated to indigo tones
- Terminal cursor, selection, and prompt colours updated
- Chatbar bolt icon, send button, hover states all indigo

### Showcase deck: "The World's Your Oyster" redesign

- Replaced old-school scrolling webpage with modern scroll-driven reveal experience
- Threads WebGL shader background (indigo flowing lines, mouse-reactive) replaces FaultyTerminal
- GSAP ScrollTrigger word-by-word blur reveal on scroll (text sharpens as it reaches centre)
- Hero: typing animation with leading cursor — "Tools are dead." then "Welcome to Oyster."
- Scroll indicator: mouse oval with bouncing dot, fades on first scroll
- "Your work is scattered" slide: Matter.js physics — tool names fall and tumble dramatically
- Format list: alternating lavender/white — docs / slides / mind maps / apps / games / boards / sheets / charts / sites
- Chat bar mockup with animated conic gradient glow border
- Stats section: big bold numbers (1 surface, infinite artifacts, 0 tabs)
- All copy tightened (Zinsser method) — removed jargon, shorter sentences throughout
- Unified indigo palette — no more green/blue colour clash

### Chat and UX fixes

- Click outside chatbar collapses with animation; click bar to re-expand (works during streaming)
- Placeholder hidden while AI is streaming
- Disabled input uses pointer-events:none so clicks fall through to expand chat
- Agent instructions: artifacts dir is the lookup path for existing user content
- ViewerWindow iframe src memoised to prevent game restarts from polling re-renders
- Server: query param stripping for static file serving (fixes cache-bust 404)
- OpenCode spawned from project root (finds .opencode/agents/oyster.md)

## 2026-03-14

### Artifact contract and Tier 1 pipeline

- Defined the artifact contract: every generated output gets a folder, manifest.json, and source files under `/artifacts/<id>/`
- Manifest schema: id, name, type, runtime, entrypoint, ports, storage, capabilities, status, timestamps
- Server detects artifacts by reading manifests first, falling back to filename inference for legacy files
- Static file serving for `/artifacts/` path with markdown rendering
- Recursive scan on startup finds existing artifacts in subdirectories
- Agent instructions (oyster.md) rewritten with full artifact creation contract and examples
- Added `table` artifact type (cyan, grid icon) for spreadsheets and structured data
- Generated static apps open in ViewerWindow iframe instead of trying to start a dev server
- Cache-busting on iframe src so updated artifacts always show fresh content
- Query param stripping in static file server to support cache-busting

### Architecture documentation

- Superseded design doc with artifact contract, runtime tiers (static/vite/docker), and deployment models (single machine, control plane + runtime, central AI pool)
- Deleted stale implementation doc, consolidated all content into single living design doc
- Renamed to `oyster-os-design.md` (removed date prefix)

### Chat improvements

- Markdown rendering in assistant chat bubbles (installed marked, added .chat-markdown styles)
- Filtered out empty tool-use message bubbles (no more `...` spam)
- Session creation retries on 502 (handles OpenCode still starting up)
- Click outside chatbar collapses messages panel with smooth animation
- Click/focus on input expands messages panel
- CSS transition for expand/collapse (opacity, transform, max-height)

### Fixes

- OpenCode serve now runs from project root (finds .opencode/agents/oyster.md)
- PROJECT_ROOT hoisted to top of server for consistent use
- Status dot on artifact icons only shows for registry apps with dev server ports
- Self-healing artifact cleanup passes id for proper cache invalidation

## 2026-03-13

### Sprint 2: Wire the engine

- OpenCode terminal embedded in surface (xterm.js + WebSocket PTY)
- HTTP+WS hybrid server with app process management
- Real workspace artifacts (Tokinvest apps + docs) replace mock data
- Space-based navigation with pill row
- Fresh session model (home = new session, session URLs bookmarkable)
- Deck artifacts open fullscreen with draggable toolbar
- Chat API layer with SSE streaming to OpenCode
- Self-healing artifact cleanup and name override system
- Showcase deck with WebGL shader background

## 2026-03-12

### Sprint 1: UI mockup

- Surface with Aurora WebGL animated background
- Typed artifact icons on grid with colour-coded badges
- Chat bar embedded at bottom of surface
- Simulated chat streaming with mock responses
- Window system with viewer, z-order, drag
- Glassmorphic viewer window with iframe
