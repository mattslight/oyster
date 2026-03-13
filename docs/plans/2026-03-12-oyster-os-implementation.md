# Oyster OS — PoC Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a visual surface where AI-generated outputs appear as typed icons, with an embedded chat bar for talking to the AI. Sprint 1 is a UI mockup with fake data — prove the feel before wiring the engine.

**Sprint strategy:** UI first (sprint 1, fake data), engine second (sprint 2, OpenCode + Supabase).

**Tech Stack (Sprint 1):** React 19, Vite, plain CSS. No backend. Mock data only.

**Tech Stack (Sprint 2):** OpenCode (`opencode serve`), Supabase (Postgres), local Postgres (for app data). Optional: thin proxy for CORS.

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

## Task 1: Desktop Surface + Taskbar

**Files:**
- Create: `web/src/components/Desktop.tsx`
- Create: `web/src/components/Taskbar.tsx`
- Create: `web/src/components/ArtifactIcon.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/index.css`

**Step 1: Write ArtifactIcon**

`web/src/components/ArtifactIcon.tsx` — typed icon with colour, badge, label. Each artifact type gets a distinct visual identity:
- `wireframe` — purple/indigo, layout icon
- `deck` — purple/indigo, presentation icon
- `map` — green, layers icon
- `notes` — green, document icon
- `app` — blue, code icon
- `diagram` — amber, flow icon

Click handler opens the artifact in a viewer window.

**Step 2: Write Desktop**

`web/src/components/Desktop.tsx` — the main surface:
- Background: dark gradient with subtle dot grid (like tokinvest prototype)
- Icon grid: `grid-template-columns: repeat(auto-fill, 120px)`, 32px padding
- Renders `ArtifactIcon` for each artifact
- Fade-in animation on mount (staggered per icon)
- Fills the viewport minus taskbar height (48px)

**Step 3: Write Taskbar**

`web/src/components/Taskbar.tsx` — bottom bar:
- Left: Oyster brand button (green, like tokinvest's start button) — opens chat window
- Left: divider, then minimized window chips (if any)
- Right: status dot + "LOCAL" label, clock (updates every 10s)
- Height: 48px, fixed at bottom
- Dark background with blur

**Step 4: Wire up App.tsx**

```typescript
export default function App() {
  return (
    <div className="h-screen flex flex-col">
      <Desktop />
      <Taskbar />
    </div>
  );
}
```

**Step 5: Test**

```bash
cd web && npm run dev
```

Expected: See a dark desktop with 4 artifact icons (from mock data), a taskbar at the bottom with "Oyster" button, status dot, and clock.

**Step 6: Commit**

```bash
git add web/
git commit -m "feat: desktop surface with artifact icons and taskbar"
```

---

## Task 2: Window System

**Files:**
- Create: `web/src/components/WindowChrome.tsx`
- Create: `web/src/components/ChatWindow.tsx`
- Create: `web/src/components/ViewerWindow.tsx`
- Create: `web/src/stores/windows.ts`

**Step 1: Write window state store**

`web/src/stores/windows.ts` — manages which windows are open, minimized, or closed:
```typescript
interface WindowState {
  id: string;
  type: "chat" | "viewer";
  title: string;
  minimized: boolean;
  statusText?: string; // shown in taskbar when minimized
  artifactPath?: string; // for viewer windows
}
```

Use React state (useState/useReducer in App) or a small store (zustand if needed). Keep it simple — no library for sprint 1.

Actions: openChat, openViewer, minimizeWindow, closeWindow, updateStatusText.

**Step 2: Write WindowChrome**

`web/src/components/WindowChrome.tsx` — reusable window frame:
- Title bar with window title, minimize button (—), close button (×)
- Fixed position on the desktop (absolute, z-index above desktop, below taskbar)
- Children rendered in the window body
- Subtle shadow and rounded corners
- Dark theme matching the desktop

**Step 3: Write ChatWindow**

`web/src/components/ChatWindow.tsx` — floating chat window:
- Uses `WindowChrome` for the frame
- Message list (user messages right-aligned blue, assistant left-aligned dark)
- Text input at the bottom with send button
- Simulated streaming: on send, match against `mockResponses`, then reveal response text chunk by chunk with delays (50-100ms per chunk) to simulate streaming
- If the matched response has `generatesArtifact`, add the artifact to the desktop after the response completes (with a brief delay)
- During streaming, update the window's `statusText` with a truncated preview of the latest chunk (shown in taskbar when minimized)

**Step 4: Write ViewerWindow**

`web/src/components/ViewerWindow.tsx` — artifact viewer:
- Uses `WindowChrome` for the frame
- Renders an iframe pointing to the artifact path
- For the mock, create simple demo HTML files in `web/public/demo/` (wireframe placeholder, deck placeholder, etc.)
- Title shows the artifact name

**Step 5: Connect to Taskbar**

Update `Taskbar.tsx`:
- Oyster button → calls `openChat()`
- Minimized windows render as chips in the taskbar with their `statusText` scrolling/truncated
- Click a chip → restore that window (un-minimize)

Update `Desktop.tsx`:
- Click an artifact icon → calls `openViewer(artifact)`

**Step 6: Test**

1. Open browser → see desktop with icons and taskbar
2. Click "Oyster" button → chat window appears floating over desktop
3. Type "make me a mind map" → simulated streaming response, new artifact appears on desktop
4. Click minimize on chat → chat collapses to taskbar chip with status text
5. Click a desktop icon → viewer window opens with iframe content
6. Close windows → they disappear

**Step 7: Commit**

```bash
git add web/
git commit -m "feat: window system — chat window, viewer window, minimize to taskbar"
```

---

## Task 3: Polish + Feel

**Files:**
- Modify: various component files
- Create: `web/public/demo/*.html` — demo content for viewer

**Step 1: Animations**
- Window open: scale from 0.95 + fade in (150ms ease-out)
- Window close: scale to 0.95 + fade out (100ms)
- Window minimize: shrink toward the taskbar chip position (200ms)
- New artifact appearing on desktop: fade up from below (like tokinvest)

**Step 2: Demo content**

Create placeholder HTML files in `web/public/demo/`:
- `wireframe.html` — simple wireframe mockup
- `deck.html` — presentation slide placeholder
- `map.html` — mind map placeholder (could use D3 or just styled HTML)
- `notes.html` — rendered markdown-style notes

These don't need to be impressive — just enough to prove the viewer works and the window system feels right.

**Step 3: Chat feel**
- Streaming text appears character-by-character or chunk-by-chunk
- "Generating..." status in taskbar while response is streaming
- New artifact icon on desktop has a brief "generating" state (pulsing badge) before becoming "ready"

**Step 4: Responsive**
- Desktop-only for sprint 1. Set a minimum width (1024px) and show a "use on desktop" message below that.

**Step 5: Commit**

```bash
git add web/
git commit -m "feat: polish — animations, demo content, streaming feel"
```

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

| Task | What | Depends On |
|------|------|------------|
| 0 | Project scaffold + mock data | — |
| 1 | Desktop surface + taskbar | 0 |
| 2 | Window system (chat + viewer) | 0, 1 |
| 3 | Polish + feel | 2 |
| 4 | Review + iterate | 3 |

---

# Sprint 2: Wire the Engine

> Not yet detailed at task level. High-level scope:

### Infrastructure
- Install OpenCode on VM, configure providers, run `opencode serve`
- Supabase schema: nodes, edges, artifacts tables (no RLS for PoC)
- `.opencode/agents/oyster.md` product conventions (content unchanged from design doc)

### Frontend wiring
- Replace mock data with Supabase queries + realtime subscriptions
- Replace simulated chat with real HTTP/SSE to OpenCode
- `POST /session/{id}/message` to send, `GET /event` SSE to receive
- Real artifact generation → new icons appear on desktop via Supabase realtime

### End-to-end smoke test
1. Open Oyster → see desktop
2. Open chat → "I'm working on KPS with Bharat" → knowledge graph updated
3. "Create a mind map" → artifact generated, appears on desktop
4. Click artifact → opens in viewer window
5. Verify Supabase has correct nodes, edges, artifacts

---

# Sprint 3+: Polish the OS

- Drag and resize windows
- Multiple simultaneous chat windows
- Auto-hygiene (old chats → "Chat History" icon on desktop)
- Seeded starter artifacts on first use/import
- Right-click context menus on artifacts
- Folders / grouping on desktop
- Desktop search
- Spatial memory (user-arranged icon positions)

---

## Known Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Window management becomes a rabbit hole | Sprint 1: one chat window, no drag/resize, fixed position, minimize only |
| Desktop feels empty on first use | Accept for sprint 1. Sprint 2+ adds seeded starter artifacts on import |
| OpenCode SSE event format differs from expected | Sprint 2: check `/doc` OpenAPI spec before writing client |
| CORS blocks frontend from hitting OpenCode | Sprint 2: use thin proxy or configure OpenCode CORS |
| Artifact type rendering varies | Start with iframe-only. Type-specific renderers in sprint 3 |
| Chat in a floating window feels cramped | Test in sprint 1 mockup. If it does, adjust window size or allow expand-to-full |
