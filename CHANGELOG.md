# Changelog

## 2026-03-28

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
