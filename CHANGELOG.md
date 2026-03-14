# Changelog

## 2026-03-14

### Artefact contract and Tier 1 pipeline

- Defined the artefact contract: every generated output gets a folder, manifest.json, and source files under `/artefacts/<id>/`
- Manifest schema: id, name, type, runtime, entrypoint, ports, storage, capabilities, status, timestamps
- Server detects artefacts by reading manifests first, falling back to filename inference for legacy files
- Static file serving for `/artefacts/` path with markdown rendering
- Recursive scan on startup finds existing artefacts in subdirectories
- Agent instructions (oyster.md) rewritten with full artefact creation contract and examples
- Added `table` artefact type (cyan, grid icon) for spreadsheets and structured data
- Generated static apps open in ViewerWindow iframe instead of trying to start a dev server
- Cache-busting on iframe src so updated artefacts always show fresh content
- Query param stripping in static file server to support cache-busting

### Architecture documentation

- Superseded design doc with artefact contract, runtime tiers (static/vite/docker), and deployment models (single machine, control plane + runtime, central AI pool)
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
- Status dot on artefact icons only shows for registry apps with dev server ports
- Self-healing artifact cleanup passes id for proper cache invalidation

## 2026-03-13

### Sprint 2: Wire the engine

- OpenCode terminal embedded in surface (xterm.js + WebSocket PTY)
- HTTP+WS hybrid server with app process management
- Real workspace artefacts (Tokinvest apps + docs) replace mock data
- Space-based navigation with pill row
- Fresh session model (home = new session, session URLs bookmarkable)
- Deck artefacts open fullscreen with draggable toolbar
- Chat API layer with SSE streaming to OpenCode
- Self-healing artefact cleanup and name override system
- Showcase deck with WebGL shader background

## 2026-03-12

### Sprint 1: UI mockup

- Surface with Aurora WebGL animated background
- Typed artefact icons on grid with colour-coded badges
- Chat bar embedded at bottom of surface
- Simulated chat streaming with mock responses
- Window system with viewer, z-order, drag
- Glassmorphic viewer window with iframe
