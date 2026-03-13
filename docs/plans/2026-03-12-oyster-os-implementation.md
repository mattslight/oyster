# Oyster OS — PoC Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a visual surface where AI-generated outputs appear as typed icons, with an embedded chat bar for talking to the AI. Sprint 1 is a UI mockup with fake data — prove the feel before wiring the engine.

**Sprint strategy:** UI first (sprint 1, fake data), engine second (sprint 2, OpenCode + Supabase).

**Tech Stack (Sprint 1):** React 19, Vite, plain CSS. No backend. Mock data only.

**Tech Stack (Sprint 2):** OpenCode (via node-pty + xterm.js WebSocket PTY), Supabase (Postgres + realtime), WebSocket server (`server/`). Chat bar will send messages to the running OpenCode session.

**Design doc:** `docs/plans/2026-03-12-oyster-os-design.md`

---

# Sprint 1: UI Mockup

## Task 0: Project Scaffold

**Files:**
- Create: `oyster-os/package.json`
- Create: `oyster-os/.gitignore`
- Create: `oyster-os/web/` — Vite + React + Tailwind project
- Create: `oyster-os/web/src/data/mock-artifacts.ts`
- Create: `oyster-os/web/src/data/mock-chat.ts`

**Step 1: Create the project**

```bash
mkdir -p ~/Dev/oyster-os
cd ~/Dev/oyster-os
git init
npm create vite@latest web -- --template react-ts
cd web && npm install && npm install -D tailwindcss @tailwindcss/vite
```

**Step 2: Create .gitignore**

```
node_modules/
dist/
.env
.env.local
```

**Step 3: Create mock data**

`web/src/data/mock-artifacts.ts`:
```typescript
export interface Artifact {
  id: string;
  name: string;
  type: "wireframe" | "deck" | "map" | "notes" | "app" | "diagram";
  status: "ready" | "generating";
  path: string;
  createdAt: string;
}

export const mockArtifacts: Artifact[] = [
  {
    id: "1",
    name: "Homepage Wireframe",
    type: "wireframe",
    status: "ready",
    path: "/demo/wireframe.html",
    createdAt: "2026-03-13T10:00:00Z",
  },
  {
    id: "2",
    name: "Audit Presentation",
    type: "deck",
    status: "ready",
    path: "/demo/deck.html",
    createdAt: "2026-03-13T10:30:00Z",
  },
  {
    id: "3",
    name: "Product Surface Map",
    type: "map",
    status: "ready",
    path: "/demo/map.html",
    createdAt: "2026-03-13T11:00:00Z",
  },
  {
    id: "4",
    name: "Discussion Notes",
    type: "notes",
    status: "ready",
    path: "/demo/notes.html",
    createdAt: "2026-03-13T11:30:00Z",
  },
];
```

`web/src/data/mock-chat.ts`:
```typescript
// Simulated streaming responses for feel testing
export const mockResponses = [
  {
    trigger: /mind map|map/i,
    chunks: [
      "I'll create a mind map of everything we've discussed.",
      " Let me pull the key topics from our conversation...",
      "\n\nGenerating your mind map now.",
    ],
    generatesArtifact: {
      id: "5",
      name: "Discussion Mind Map",
      type: "map" as const,
      status: "ready" as const,
      path: "/demo/map.html",
      createdAt: new Date().toISOString(),
    },
  },
  {
    trigger: /todo|task/i,
    chunks: [
      "I'll build a simple task tracker for you.",
      " Setting up the app with your project context...",
      "\n\nYour task app is ready on the desktop.",
    ],
    generatesArtifact: {
      id: "6",
      name: "KPS Task Tracker",
      type: "app" as const,
      status: "ready" as const,
      path: "/demo/app.html",
      createdAt: new Date().toISOString(),
    },
  },
];

export const defaultResponse = [
  "I've noted that. ",
  "Let me structure this into your knowledge graph.",
  "\n\nDone — I've added the relevant nodes and relationships.",
];
```

**Step 4: Commit**

```bash
git add .
git commit -m "feat: initial project scaffold with mock data"
```

---

## Task 1: Surface + Chat Bar

**Files:**
- Create: `web/src/components/Desktop.tsx`
- Create: `web/src/components/ArtifactIcon.tsx`
- Create: `web/src/components/ChatBar.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/index.css`

**What was built:**

`ArtifactIcon.tsx` — typed icon with colour, badge, label. Each artifact type gets a distinct visual identity (wireframe, deck, map, notes, app, diagram). Click handler opens the artifact in a viewer window.

`Desktop.tsx` — the main surface with Aurora WebGL animated background (ogl library). Icon grid renders artifacts. Clock in top-right corner.

`ChatBar.tsx` — embedded bar at bottom-centre of the surface (replaces both the dock/taskbar and floating chat window from the original plan). Contains: Oyster icon button, text input, send button. Glass-effect with backdrop blur. Messages panel expands upward when active. Simulated streaming responses from mock data.

---

## Task 2: Window System

**Files:**
- Create: `web/src/components/WindowChrome.tsx`
- Create: `web/src/components/ViewerWindow.tsx`
- Create: `web/src/stores/windows.ts`

**What was built:**

`windows.ts` — useReducer store managing open windows. Window types: `viewer`, `terminal`. No minimize state — windows are open or closed (iOS model). Z-order tracked via `topZ` counter; FOCUS action brings window to front.

`WindowChrome.tsx` — reusable window frame with title bar, close button (×), pointer-based drag. No minimize button. Position stored in ref to survive re-renders. `onMouseDown={onFocus}` on outer div for z-order.

`ViewerWindow.tsx` — artifact viewer using WindowChrome. Renders iframe pointing to artifact path. Glassmorphic styling.

---

## Task 3: Polish + Feel

**What was built:**

- Window open: scale from 0.95 + fade in (CSS `window-enter` animation)
- New artifact appearing on desktop: fade-in animation
- Simulated streaming in chat bar: chunk-by-chunk text reveal with status text in bar
- Demo HTML files in `web/public/demo/` for viewer testing
- Aurora WebGL animated background (ogl library)

---

## Task 4: Review + Iterate

**No code — review only.**

1. Open the app in browser, walk through the full flow
2. Screenshot the key states: empty desktop, desktop with icons, chat open, chat minimized with status, viewer open
3. Ask: "Would you use this?"
4. Identify what needs to change before wiring real data in sprint 2
5. Note any UX issues for iteration

---

## Sprint 1 Task Summary

| Task | What | Status |
|------|------|--------|
| 0 | Project scaffold + mock data | Done |
| 1 | Surface + chat bar (Aurora, icons, embedded bar) | Done |
| 2 | Window system (viewer, z-order, no minimize) | Done |
| 3 | Polish + feel (animations, streaming, demo content) | Done |

---

# Sprint 2: Wire the Engine

### Done
- [x] OpenCode terminal embedded in surface (xterm.js + node-pty WebSocket PTY server)
- [x] Persistent session — OpenCode spawns once, clients attach/detach, scrollback replay on reconnect
- [x] Agent config (`.opencode/agents/oyster.md`) — workspace firewall, context awareness
- [x] No minimize — windows are open or closed (iOS model)
- [x] Click-to-focus z-order for windows
- [x] Server restructured to HTTP+WS hybrid (same port 4200)
- [x] App process management — start/stop Vite dev servers via API
- [x] Local JSON registry (`server/registry.json`) for apps + docs
- [x] Real Tokinvest workspace artifacts replace mock data (2 apps + 4 docs)
- [x] Status polling (5s) with live app status (online/offline/starting)
- [x] Hero state chat bar — centered and bold when surface is empty
- [x] Space-based navigation — hero landing with tokinvest/personal/kps space buttons
- [x] Hero tagline system — "Tools are dead. Welcome to the shell." with rotating nudges on blur
- [x] Ultra Hardcore terminal gate — first-time confirmation modal (localStorage gated)
- [x] Multi-space artifact filtering — `space` field in registry, filtered on frontend
- [x] Markdown rendering for doc artifacts — `marked` library, styled dark theme
- [x] Rotating placeholder text — curated phrases instead of static placeholder
- [x] Space pills navigation — persistent pill row above chatbar for switching spaces (replaces old resume session button + hero-only space buttons)
- [x] Fresh session model — home (`/`) always starts a new session, session URLs (`/session/:id`) are bookmarkable and refreshable
- [x] Deck artifacts open fullscreen by default with draggable light frosted-glass toolbar
- [x] Self-healing artifact cleanup — stale entries auto-removed when backing file is deleted/renamed
- [x] Artifact name override system — `NAME_OVERRIDES` map for filenames that can't contain special characters (e.g. apostrophes)
- [x] "The World's Your Oyster" showcase deck with FaultyTerminal WebGL shader background (ogl, vanilla JS)
- [x] Chat API layer (`chat-api.ts`) — SSE streaming to OpenCode, session create/load/send

### Remaining
- [ ] Wire chat bar input to OpenCode session (send user messages to the running OpenCode process)
- [ ] Supabase schema: nodes, edges, artifacts tables (no RLS for PoC)
- [ ] Supabase realtime subscriptions (replaces JSON registry)
- [ ] Real artifact generation — OpenCode creates artifacts, they appear on the surface

---

# Sprint 3+: Polish

- Window resize handles
- Agents as persistent AI workers on the surface
- Session browser/search UI (browse and revisit past conversations)
- Cross-session AI references (Oyster recalls and pulls context from past sessions)
- Bar as universal input (search + navigation)
- Richer starter content for personal/kps spaces
- Right-click context menus on artifacts
- Spatial memory (user-arranged icon positions)
- Data imports (ChatGPT, Claude, documents)

---

## Known Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Surface feels empty on first use | Accept for PoC. Later: seeded starter artifacts on import |
| Artifact type rendering varies | Start with iframe-only. Type-specific renderers in sprint 3 |
| Touch device drag conflicts | Pointer events conflict with touch scrolling — not a PoC blocker, desktop-first |
| Deployment: single VPS vs split | PoC: single VPS (nginx + WS server + OpenCode). Revisit for multi-user. |
