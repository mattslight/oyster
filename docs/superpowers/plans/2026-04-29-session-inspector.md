# Session Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-anchored slide-panel inspector that opens on session/artefact tile click, showing transcript + touched artefacts (sessions) or metadata + linked sessions (artefacts), with live-updating transcripts over the existing SSE stream.

**Architecture:** Single shared chrome (`InspectorPanel`) portals to `document.body` matching the `ConfirmModal` pattern. Content is delegated to `SessionInspector` or `ArtefactInspector` based on `activePanel.kind`. Session inspector subscribes to the existing `session_changed` SSE event via the shared `subscribeUiEvents` channel — no new EventSource. Race protection mirrors the `useSessions` hook's `latestReqId` pattern (codebase convention) with a 200ms trailing-edge debounce on event bursts.

**Tech Stack:** React 18, TypeScript, plain CSS, Node `http` server, SQLite (read-only consumption), shared types in `shared/types.ts`.

**Spec:** `docs/superpowers/specs/2026-04-29-session-inspector-design.md` (commit `22cfeb5`)

**Branch:** `feat/session-inspector` (already created)

**Verification convention:** This codebase has no unit-test framework. Per `CLAUDE.md`, verification = `npm run build` (type-check) + targeted browser scenarios. Server endpoints are smoke-tested with `curl`. This plan adapts the TDD ritual into "write code → type-check → curl/browser-probe → commit" — same intent, project-native execution.

---

## File map (locks decomposition)

### Create

| File | Responsibility |
|---|---|
| `web/src/components/InspectorPanel.tsx` | Chrome only: backdrop, slide container, escape handler, portal-to-body. Accepts `activePanel` prop and renders the right inspector inside. |
| `web/src/components/InspectorPanel.css` | All panel styling (backdrop, slide-in transition, header, tabs, footer, body, banners, link rows). Adapted from prototype lines 951–1320. |
| `web/src/components/SessionInspector.tsx` | Header + state banner + Transcript tab + Artefacts tab + footer. Owns its own data fetches (session row, events, artefacts). |
| `web/src/components/ArtefactInspector.tsx` | Metadata header + linked Sessions list + footer. No tabs. |
| `web/src/components/KindThumb.tsx` | Reusable kind-coloured artefact thumbnail (small in link rows, large in artefact inspector header). Reads from `typeConfig` in `ArtifactIcon.tsx`. |

### Modify

| File | Change |
|---|---|
| `shared/types.ts` | Add `SessionEvent`, `SessionArtifact`, `SessionEventRole`, `SessionArtifactRole` types. Add `SessionArtifactJoined` and `SessionJoinedForArtifact` for joined endpoint responses. |
| `server/src/index.ts` | Insert four new GET routes near the existing `/api/sessions` handler (line ~536). |
| `web/src/data/sessions-api.ts` | Add `fetchSession`, `fetchSessionEvents`, `fetchSessionArtifacts`. Re-export new shared types. |
| `web/src/data/artifacts-api.ts` | Add `fetchSessionsForArtifact`. |
| `web/src/components/Home.tsx` | `activePanel` state, onClick wiring on `SessionTile`/`SessionRow`/artefact tiles, render `<InspectorPanel>`. |

### No test files

This codebase doesn't have a unit-test framework set up. Verification is type-check + targeted browser/curl scenarios. Don't introduce a new framework as part of this PR.

---

## Task 1: Shared types

**Files:**
- Modify: `shared/types.ts` (append after the existing `Session` interface — search for `interface Session` to find it)

- [ ] **Step 1: Add session-event / session-artifact types**

Append to `shared/types.ts`:

```typescript
export type SessionEventRole =
  | "user"
  | "assistant"
  | "tool"
  | "tool_result"
  | "system";

export type SessionArtifactRole = "create" | "modify" | "read";

/** A single transcript turn or tool call captured by the watcher. */
export interface SessionEvent {
  id: number;
  sessionId: string;
  role: SessionEventRole;
  text: string;
  ts: string;
  /** Raw JSONL line as written by the agent. Populated when `text` alone is insufficient (tool calls, tool results). */
  raw: string | null;
}

/** A session × artefact join row (M:N — sessions may touch many artefacts). */
export interface SessionArtifact {
  id: number;
  sessionId: string;
  artifactId: string;
  role: SessionArtifactRole;
  whenAt: string;
}

/** API response shape: a SessionArtifact joined with its Artifact row. */
export interface SessionArtifactJoined extends SessionArtifact {
  artifact: Artifact;
}

/** API response shape: a SessionArtifact joined with its Session row (used by /api/artifacts/:id/sessions). */
export interface SessionJoinedForArtifact extends SessionArtifact {
  session: Session;
}
```

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit && cd ../server && npx tsc --noEmit`
Expected: PASS (the new types are unused at this point but valid).

- [ ] **Step 3: Commit**

```bash
git add shared/types.ts
git commit -m "feat(types): add SessionEvent + SessionArtifact shared types

Foundation for the session inspector slide-panel (#253). The watcher
already persists these rows to SQLite; this just exposes them on the
wire so web can fetch transcripts and join artefact provenance."
```

---

## Task 2: Server API endpoints

**Files:**
- Modify: `server/src/index.ts` (insert after line ~552, before the `/api/artifacts` GET handler)
- Reference: `server/src/session-store.ts` (existing methods: `getById`, `getEventsBySession`, `getArtifactsBySession`, `getSessionsByArtifact`)

- [ ] **Step 1: Inspect the existing handler patterns**

Read `server/src/index.ts` around line 536 (the existing `/api/sessions` handler) to confirm the response-shape convention (camelCase keys, snake_case → camelCase translation done in the handler).

- [ ] **Step 2: Add four new GET routes**

Insert after the existing `/api/sessions` block (before `/api/artifacts`):

```typescript
// GET /api/sessions/:id — single session row (or 404)
{
  const m = url.match(/^\/api\/sessions\/([^/]+)$/);
  if (m && req.method === "GET") {
    if (rejectIfNonLocalOrigin()) return;
    const row = sessionStore.getById(m[1]);
    if (!row) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "session not found" }));
      return;
    }
    sendJson({
      id: row.id,
      spaceId: row.space_id,
      agent: row.agent,
      title: row.title,
      state: row.state,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      model: row.model,
      lastEventAt: row.last_event_at,
    });
    return;
  }
}

// GET /api/sessions/:id/events — full transcript (oldest first)
{
  const m = url.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (m && req.method === "GET") {
    if (rejectIfNonLocalOrigin()) return;
    const events = sessionStore.getEventsBySession(m[1]);
    sendJson(events.map((e) => ({
      id: e.id,
      sessionId: e.session_id,
      role: e.role,
      text: e.text,
      ts: e.ts,
      raw: e.raw,
    })));
    return;
  }
}

// GET /api/sessions/:id/artifacts — touched artefacts joined with artifact metadata
{
  const m = url.match(/^\/api\/sessions\/([^/]+)\/artifacts$/);
  if (m && req.method === "GET") {
    if (rejectIfNonLocalOrigin()) return;
    const touches = sessionStore.getArtifactsBySession(m[1]);
    const allArtifacts = await artifactService.getAllArtifacts(() => {});
    const byId = new Map(allArtifacts.map((a) => [a.id, a]));
    sendJson(touches.flatMap((t) => {
      const a = byId.get(t.artifact_id);
      if (!a) return []; // artifact archived or missing — drop
      return [{
        id: t.id,
        sessionId: t.session_id,
        artifactId: t.artifact_id,
        role: t.role,
        whenAt: t.when_at,
        artifact: a,
      }];
    }));
    return;
  }
}

// GET /api/artifacts/:id/sessions — sessions that touched this artefact (M:N reverse)
{
  const m = url.match(/^\/api\/artifacts\/([^/]+)\/sessions$/);
  if (m && req.method === "GET") {
    if (rejectIfNonLocalOrigin()) return;
    const touches = sessionStore.getSessionsByArtifact(m[1]);
    const allSessions = sessionStore.getAll();
    const byId = new Map(allSessions.map((s) => [s.id, s]));
    sendJson(touches.flatMap((t) => {
      const s = byId.get(t.session_id);
      if (!s) return [];
      return [{
        id: t.id,
        sessionId: t.session_id,
        artifactId: t.artifact_id,
        role: t.role,
        whenAt: t.when_at,
        session: {
          id: s.id,
          spaceId: s.space_id,
          agent: s.agent,
          title: s.title,
          state: s.state,
          startedAt: s.started_at,
          endedAt: s.ended_at,
          model: s.model,
          lastEventAt: s.last_event_at,
        },
      }];
    }));
    return;
  }
}
```

**Important:** the `/api/artifacts/:id/sessions` route must come BEFORE the existing `/api/artifacts/:id` PATCH/POST routes so the suffix is matched first. Place it near line ~565 (before the artifact mutation block).

- [ ] **Step 3: Type-check the server build**

Run: `cd server && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Smoke-test with curl**

Start dev server (`npm run dev` from repo root) in another terminal. Then:

```bash
# Should return a session list — pick an id from it
curl -s http://localhost:3333/api/sessions | head -c 400

# Substitute an actual session id
SID="<paste-id-from-above>"
curl -s http://localhost:3333/api/sessions/$SID | head -c 400
curl -s http://localhost:3333/api/sessions/$SID/events | head -c 400
curl -s http://localhost:3333/api/sessions/$SID/artifacts | head -c 400

# Substitute an actual artifact id (from /api/artifacts)
AID="<paste-id>"
curl -s http://localhost:3333/api/artifacts/$AID/sessions | head -c 400

# 404 path
curl -s http://localhost:3333/api/sessions/does-not-exist
# Expected: {"error":"session not found"}
```

Expected: each endpoint returns valid JSON with camelCase keys; 404 returns the error shape.

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(api): add session/artefact inspector endpoints

Four new GETs feeding the slide-panel inspector (#253):
- /api/sessions/:id            — single session row
- /api/sessions/:id/events     — full transcript
- /api/sessions/:id/artifacts  — touched artefacts (joined)
- /api/artifacts/:id/sessions  — sessions that touched it (joined)

Local-origin only (matches existing /api/sessions). Thin wrappers over
SessionStore methods that already exist; no new SQL."
```

---

## Task 3: Web data layer

**Files:**
- Modify: `web/src/data/sessions-api.ts`
- Modify: `web/src/data/artifacts-api.ts`

- [ ] **Step 1: Extend `sessions-api.ts`**

Replace the file contents with:

```typescript
export type {
  Session,
  SessionState,
  SessionAgent,
  SessionEvent,
  SessionEventRole,
  SessionArtifact,
  SessionArtifactRole,
  SessionArtifactJoined,
  SessionJoinedForArtifact,
} from "../../../shared/types";
import type {
  Session,
  SessionEvent,
  SessionArtifactJoined,
} from "../../../shared/types";

export async function fetchSessions(): Promise<Session[]> {
  const res = await fetch("/api/sessions");
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
}

export async function fetchSession(id: string, signal?: AbortSignal): Promise<Session> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { signal });
  if (res.status === 404) throw new SessionNotFoundError(id);
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
}

export async function fetchSessionEvents(id: string, signal?: AbortSignal): Promise<SessionEvent[]> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/events`, { signal });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
}

export async function fetchSessionArtifacts(id: string, signal?: AbortSignal): Promise<SessionArtifactJoined[]> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/artifacts`, { signal });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
}

export class SessionNotFoundError extends Error {
  constructor(public sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}
```

- [ ] **Step 2: Extend `artifacts-api.ts`**

Read the existing `web/src/data/artifacts-api.ts` first to see what's there. Append:

```typescript
import type { SessionJoinedForArtifact } from "../../../shared/types";

export async function fetchSessionsForArtifact(
  id: string,
  signal?: AbortSignal,
): Promise<SessionJoinedForArtifact[]> {
  const res = await fetch(`/api/artifacts/${encodeURIComponent(id)}/sessions`, { signal });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
}
```

- [ ] **Step 3: Type-check the web build**

Run: `cd web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add web/src/data/sessions-api.ts web/src/data/artifacts-api.ts
git commit -m "feat(web): data fetchers for inspector

Adds fetchSession, fetchSessionEvents, fetchSessionArtifacts on the
sessions side, and fetchSessionsForArtifact on the artefacts side.
SessionNotFoundError typed so callers can handle 404 distinctly from
network/500 errors. AbortSignal support so the inspector can cancel
in-flight fetches when its target id changes (#253)."
```

---

## Task 4: InspectorPanel chrome + KindThumb helper

**Files:**
- Create: `web/src/components/InspectorPanel.tsx`
- Create: `web/src/components/InspectorPanel.css`
- Create: `web/src/components/KindThumb.tsx`

- [ ] **Step 0: Create the KindThumb helper**

Create `web/src/components/KindThumb.tsx`:

```typescript
import type { ArtifactKind } from "../../../shared/types";
import { typeConfig } from "./ArtifactIcon";

interface Props {
  kind: ArtifactKind;
  /** Outer square size in pixels. Default 32 (link-row thumb). Use 64 for the artefact-inspector header. */
  size?: number;
}

/**
 * Small kind-coloured glyph used in inspector link rows and the artefact
 * inspector header. Reads colour/icon path from ArtifactIcon's typeConfig
 * so the kind palette stays consistent with the desktop tile.
 */
export function KindThumb({ kind, size = 32 }: Props) {
  const config = typeConfig[kind] ?? typeConfig.app;
  const iconSize = Math.round(size * 0.5);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.18),
        background: config.gradient,
        color: config.color,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width={iconSize}
        height={iconSize}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={config.icon} />
      </svg>
    </div>
  );
}
```

- [ ] **Step 1: Create the CSS file**

Create `web/src/components/InspectorPanel.css`:

```css
.inspector-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
  z-index: 50;
}
.inspector-backdrop.open {
  opacity: 1;
  pointer-events: auto;
}

.inspector-panel {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: min(640px, 92vw);
  background: rgba(20, 21, 40, 0.94);
  border-left: 1px solid var(--border);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  z-index: 51;
  transform: translateX(100%);
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  display: flex;
  flex-direction: column;
  box-shadow: -20px 0 60px rgba(0, 0, 0, 0.4);
}
.inspector-panel.open { transform: translateX(0); }

.inspector-header {
  padding: 24px 28px 20px;
  border-bottom: 1px solid var(--border);
}
.inspector-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.inspector-meta .space { color: var(--accent-bright); }
.inspector-meta .agent { color: var(--text); }
.inspector-meta .pip {
  width: 6px; height: 6px; border-radius: 50%;
}
.inspector-meta .pip.green { background: #4ade80; }
.inspector-meta .pip.amber { background: #fbbf24; }
.inspector-meta .pip.red   { background: #f87171; }
.inspector-meta .pip.dim   { background: var(--text-dim); }
.inspector-meta .close {
  margin-left: auto;
  cursor: pointer;
  padding: 4px 8px;
  color: var(--text-dim);
  border-radius: 4px;
  font-size: 14px;
}
.inspector-meta .close:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.07);
}
.inspector-title {
  margin-top: 12px;
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
}
.inspector-sub {
  margin-top: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
}

.inspector-banner {
  margin: 0 28px 16px;
  padding: 12px 14px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--text);
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.inspector-banner.disconnected {
  background: rgba(248, 113, 113, 0.08);
  border: 1px solid rgba(248, 113, 113, 0.2);
}
.inspector-banner.waiting {
  background: rgba(251, 191, 36, 0.08);
  border: 1px solid rgba(251, 191, 36, 0.2);
}
.inspector-banner code {
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 6px;
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 11px;
}

.inspector-tabs {
  display: flex;
  gap: 0;
  padding: 0 28px;
  border-bottom: 1px solid var(--border);
}
.inspector-tab {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-dim);
  padding: 12px 18px 10px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}
.inspector-tab:hover { color: var(--text); }
.inspector-tab.active {
  color: var(--accent-bright);
  border-bottom-color: var(--accent-bright);
}
.inspector-tab .badge {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  background: rgba(255, 255, 255, 0.07);
  border-radius: 8px;
  font-size: 10px;
  color: var(--text-dim);
}
.inspector-tab.active .badge {
  background: rgba(124, 107, 255, 0.2);
  color: var(--accent-bright);
}

.inspector-body {
  flex: 1;
  overflow-y: auto;
  padding: 22px 28px;
}
.inspector-body::-webkit-scrollbar { width: 6px; }
.inspector-body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.06);
  border-radius: 3px;
}

.inspector-footer {
  display: flex;
  gap: 8px;
  padding: 16px 28px;
  border-top: 1px solid var(--border);
}
.inspector-footer .btn {
  padding: 8px 14px;
  font-size: 12px;
}

.inspector-error {
  padding: 12px 16px;
  background: rgba(248, 113, 113, 0.08);
  border: 1px solid rgba(248, 113, 113, 0.2);
  border-radius: 8px;
  color: var(--text);
  font-size: 13px;
}
.inspector-empty {
  color: var(--text-dim);
  font-size: 13px;
}

.turn { margin-bottom: 14px; }
.turn-role {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: 4px;
}
.turn.user .turn-role { color: var(--accent-bright); }
.turn.assistant .turn-role { color: #6ee7a8; }
.turn.tool .turn-role,
.turn.tool_result .turn-role { color: #fbbf24; }
.turn-text {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
}
.turn-tool-summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-dim);
}
.turn-tool-summary:hover { color: var(--text); }
.turn-tool-raw {
  margin-top: 6px;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 320px;
  overflow-y: auto;
}
.turn-tool-truncated {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-dim);
  font-style: italic;
}

.link-row {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.link-row:hover { background: rgba(255, 255, 255, 0.04); }
.link-thumb {
  width: 32px; height: 32px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.link-body {
  flex: 1;
  min-width: 0;
}
.link-title {
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.link-meta {
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 2px;
  display: flex;
  gap: 8px;
  align-items: center;
}
.role-chip {
  padding: 1px 6px;
  border-radius: 8px;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.role-chip.create { background: rgba(74, 222, 128, 0.12); color: #6ee7a8; }
.role-chip.modify { background: rgba(251, 191, 36, 0.12); color: #fbbf24; }
.role-chip.read   { background: rgba(255, 255, 255, 0.06); color: var(--text-dim); }
```

- [ ] **Step 2: Create the chrome component**

Create `web/src/components/InspectorPanel.tsx`:

```typescript
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./InspectorPanel.css";

export type ActivePanel =
  | { kind: "session"; id: string }
  | { kind: "artefact"; id: string };

interface Props {
  /** When non-null, the panel is open. When null, the chrome unmounts entirely. */
  active: ActivePanel | null;
  onClose: () => void;
  children: ReactNode;
}

export function InspectorPanel({ active, onClose, children }: Props) {
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onClose]);

  if (!active) return null;

  return createPortal(
    <>
      <div
        className="inspector-backdrop open"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      />
      <div className="inspector-panel open" role="dialog" aria-modal="true">
        {children}
      </div>
    </>,
    document.body,
  );
}
```

Note: the `open` class is applied on mount because we unmount when `active` becomes null. (No fade-out animation in v1 — the panel just disappears. Adding mount-delayed transition is a polish follow-up.)

- [ ] **Step 3: Wire a placeholder into Home for smoke-test**

Temporarily, in `web/src/components/Home.tsx`, add at the top of the component (after `useStickyView`):

```typescript
import { InspectorPanel, type ActivePanel } from "./InspectorPanel";
// ...
const [activePanel, setActivePanel] = useState<ActivePanel | null>(null);
```

And before the closing `</div>` of the Home component:

```tsx
<InspectorPanel active={activePanel} onClose={() => setActivePanel(null)}>
  <div style={{ padding: 24, color: "white" }}>
    {activePanel?.kind === "session" ? `Session ${activePanel.id}` : `Artefact ${activePanel?.id}`}
  </div>
</InspectorPanel>
```

Add a temporary debug button somewhere visible to set it to `{ kind: "session", id: "test" }` so you can see the panel open. Or wire it briefly to `SessionTile` `onClick={() => setActivePanel({ kind: "session", id: session.id })}`.

- [ ] **Step 4: Browser-verify**

Run: `npm run dev`. Open `http://localhost:7337`. Click whatever you wired up.

Expected:
- Backdrop fades in over the page
- Panel slides in from the right
- Pressing Escape closes the panel
- Clicking the backdrop closes the panel

- [ ] **Step 5: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/components/InspectorPanel.tsx web/src/components/InspectorPanel.css web/src/components/KindThumb.tsx web/src/components/Home.tsx
git commit -m "feat(home): inspector panel chrome (slide-from-right)

Right-anchored slide panel with backdrop, escape-key close, and
portal-to-body (matches ConfirmModal pattern). Contents are passed in
as children — concrete inspectors land in following commits.

Also adds KindThumb — a reusable kind-coloured artefact glyph used in
inspector link rows and the artefact inspector header. Reads palette
from ArtifactIcon's typeConfig so the kind colours stay consistent.

Wires a temporary placeholder onto SessionTile so the chrome is
exercisable end-to-end; the placeholder is replaced with the real
SessionInspector in the next commit. Part of #253."
```

---

## Task 5: SessionInspector — full component

**Files:**
- Create: `web/src/components/SessionInspector.tsx`
- Modify: `web/src/components/Home.tsx` (replace placeholder)

This is the largest single file. It owns its own data fetches and renders header, state banner, two tabs (Transcript, Artefacts), and footer. Live-update wiring comes in Task 6 — this task ships the snapshot version.

- [ ] **Step 1: Create the component skeleton**

Create `web/src/components/SessionInspector.tsx`:

```typescript
import { useEffect, useRef, useState } from "react";
import {
  fetchSession,
  fetchSessionEvents,
  fetchSessionArtifacts,
  SessionNotFoundError,
} from "../data/sessions-api";
import type {
  Session,
  SessionEvent,
  SessionArtifactJoined,
  SessionState,
} from "../data/sessions-api";
import { KindThumb } from "./KindThumb";
import type { ActivePanel } from "./InspectorPanel";

interface Props {
  sessionId: string;
  onSwitchTo: (next: ActivePanel) => void;
  onClose: () => void;
  onNotFound: () => void;
}

const PIP_CLASS: Record<SessionState, string> = {
  active: "green",
  waiting: "amber",
  disconnected: "red",
  done: "dim",
};

const STATE_LABEL: Record<SessionState, string> = {
  active: "active",
  waiting: "waiting on you",
  disconnected: "disconnected",
  done: "done",
};

const RAW_CAP_BYTES = 4096;

type Tab = "transcript" | "artefacts";

export function SessionInspector({ sessionId, onSwitchTo, onClose, onNotFound }: Props) {
  const [session, setSession] = useState<Session | null>(null);
  const [events, setEvents] = useState<SessionEvent[] | null>(null);
  const [artefacts, setArtefacts] = useState<SessionArtifactJoined[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("transcript");
  const latestReqId = useRef(0);

  useEffect(() => {
    const reqId = ++latestReqId.current;
    setError(null);
    setSession(null);
    setEvents(null);
    setArtefacts(null);
    setTab("transcript");
    const ac = new AbortController();
    Promise.all([
      fetchSession(sessionId, ac.signal),
      fetchSessionEvents(sessionId, ac.signal),
      fetchSessionArtifacts(sessionId, ac.signal),
    ])
      .then(([s, ev, art]) => {
        if (reqId !== latestReqId.current) return;
        setSession(s);
        setEvents(ev);
        setArtefacts(art);
      })
      .catch((err) => {
        if (reqId !== latestReqId.current || ac.signal.aborted) return;
        if (err instanceof SessionNotFoundError) {
          onNotFound();
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => ac.abort();
  }, [sessionId, onNotFound]);

  if (error) {
    return (
      <>
        <header className="inspector-header">
          <div className="inspector-meta">
            <span>session</span>
            <span className="close" onClick={onClose}>✕</span>
          </div>
        </header>
        <div className="inspector-body">
          <div className="inspector-error">Couldn't load session: {error}</div>
        </div>
      </>
    );
  }

  if (!session) {
    return (
      <>
        <header className="inspector-header">
          <div className="inspector-meta">
            <span>loading…</span>
            <span className="close" onClick={onClose}>✕</span>
          </div>
        </header>
        <div className="inspector-body" />
      </>
    );
  }

  return (
    <>
      <Header session={session} onClose={onClose} />
      <Banner session={session} />
      <Tabs tab={tab} setTab={setTab} eventsCount={events?.length ?? 0} artefactsCount={artefacts?.length ?? 0} />
      <div className="inspector-body">
        {tab === "transcript" && <Transcript events={events} />}
        {tab === "artefacts" && <Artefacts items={artefacts} onSwitchTo={onSwitchTo} />}
      </div>
      <Footer session={session} />
    </>
  );
}

function Header({ session, onClose }: { session: Session; onClose: () => void }) {
  return (
    <header className="inspector-header">
      <div className="inspector-meta">
        {session.spaceId && <span className="space">{session.spaceId}</span>}
        {session.spaceId && <span>·</span>}
        <span className="agent">{session.agent}</span>
        <span>·</span>
        <span className={`pip ${PIP_CLASS[session.state]}`} />
        <span>{STATE_LABEL[session.state]}</span>
        <span className="close" onClick={onClose}>✕</span>
      </div>
      <div className="inspector-title">{session.title ?? "(no title yet)"}</div>
      <div className="inspector-sub">
        {session.id} · started {formatTs(session.startedAt)}
        {session.model ? ` · ${session.model}` : ""}
      </div>
    </header>
  );
}

function Banner({ session }: { session: Session }) {
  if (session.state === "disconnected") {
    return (
      <div className="inspector-banner disconnected">
        <div>
          Last heartbeat <strong>{formatRel(session.lastEventAt)}</strong>. The agent process may have exited or the JSONL transcript stopped updating.
        </div>
      </div>
    );
  }
  if (session.state === "waiting") {
    return (
      <div className="inspector-banner waiting">
        <div>
          Agent is waiting — usually for tool approval. Resolve it inside the agent's TUI.
        </div>
      </div>
    );
  }
  return null;
}

function Tabs({
  tab, setTab, eventsCount, artefactsCount,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  eventsCount: number;
  artefactsCount: number;
}) {
  return (
    <div className="inspector-tabs">
      <button
        type="button"
        className={`inspector-tab${tab === "transcript" ? " active" : ""}`}
        onClick={() => setTab("transcript")}
      >
        Transcript <span className="badge">{eventsCount}</span>
      </button>
      <button
        type="button"
        className={`inspector-tab${tab === "artefacts" ? " active" : ""}`}
        onClick={() => setTab("artefacts")}
      >
        Artefacts <span className="badge">{artefactsCount}</span>
      </button>
    </div>
  );
}

function Transcript({ events }: { events: SessionEvent[] | null }) {
  if (events === null) return <div className="inspector-empty">Loading transcript…</div>;
  if (events.length === 0) {
    return <div className="inspector-empty">No transcript yet. Live updates active.</div>;
  }
  return (
    <>
      {events.map((e) => (
        <Turn key={e.id} event={e} />
      ))}
    </>
  );
}

function Turn({ event }: { event: SessionEvent }) {
  if (event.role === "tool" || event.role === "tool_result") {
    return <ToolTurn event={event} />;
  }
  return (
    <div className={`turn ${event.role}`}>
      <div className="turn-role">{event.role}</div>
      <div className="turn-text">{event.text || "(empty)"}</div>
    </div>
  );
}

function ToolTurn({ event }: { event: SessionEvent }) {
  const [open, setOpen] = useState(false);
  const summary = oneLineSummary(event);
  const { display, truncated, totalBytes } = capRaw(event.raw ?? "");
  return (
    <div className={`turn ${event.role}`}>
      <div className="turn-role">{event.role}</div>
      <div className="turn-tool-summary" onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} {summary}
      </div>
      {open && event.raw && (
        <>
          <pre className="turn-tool-raw">{display}</pre>
          {truncated && (
            <div className="turn-tool-truncated">
              …truncated, {totalBytes - RAW_CAP_BYTES} more bytes
            </div>
          )}
        </>
      )}
      {!event.raw && event.text && <div className="turn-text">{event.text}</div>}
    </div>
  );
}

function Artefacts({
  items, onSwitchTo,
}: {
  items: SessionArtifactJoined[] | null;
  onSwitchTo: (next: ActivePanel) => void;
}) {
  if (items === null) return <div className="inspector-empty">Loading artefacts…</div>;
  if (items.length === 0) {
    return <div className="inspector-empty">No artefacts touched yet.</div>;
  }
  return (
    <>
      {items.map((item) => (
        <div
          key={item.id}
          className="link-row"
          onClick={() => onSwitchTo({ kind: "artefact", id: item.artifact.id })}
        >
          <KindThumb kind={item.artifact.artifactKind} />
          <div className="link-body">
            <div className="link-title">{item.artifact.label}</div>
            <div className="link-meta">
              <span className={`role-chip ${item.role}`}>{item.role}</span>
              <span>{formatRel(item.whenAt)}</span>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

// KindThumb is extracted to its own file (created earlier in Task 4 — see KindThumb.tsx)

function Footer({ session }: { session: Session }) {
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const command = `claude-code --resume ${session.id}`;

  function copyCommand() {
    if (!navigator.clipboard) {
      alert(`Copy failed — resume command:\n${command}`);
      return;
    }
    navigator.clipboard.writeText(command).then(
      () => {
        setCopiedCmd(true);
        setTimeout(() => setCopiedCmd(false), 1500);
      },
      () => alert(`Copy failed — resume command:\n${command}`),
    );
  }

  function copyId() {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(session.id).then(() => {
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 1500);
    });
  }

  return (
    <footer className="inspector-footer">
      <button type="button" className="btn primary" onClick={copyCommand}>
        {copiedCmd ? "Copied!" : "Copy resume command"}
      </button>
      <button type="button" className="btn" onClick={copyId}>
        {copiedId ? "Copied!" : "Copy session ID"}
      </button>
    </footer>
  );
}

// --- helpers ---

function formatTs(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatRel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function oneLineSummary(event: SessionEvent): string {
  // Prefer parsed tool name from raw; fall back to text snippet
  if (event.raw) {
    try {
      const parsed = JSON.parse(event.raw);
      const name = parsed?.message?.content?.[0]?.name
        ?? parsed?.toolUseResult?.name
        ?? parsed?.tool
        ?? null;
      if (name) return `Tool ${event.role === "tool" ? "call" : "result"}: ${name}`;
    } catch { /* fall through */ }
  }
  return event.role === "tool" ? "Tool call" : "Tool result";
}

function capRaw(raw: string): { display: string; truncated: boolean; totalBytes: number } {
  const totalBytes = new Blob([raw]).size;
  if (totalBytes <= RAW_CAP_BYTES) return { display: raw, truncated: false, totalBytes };
  // Slice by character is approximate but cheap; for our purposes it's fine.
  return { display: raw.slice(0, RAW_CAP_BYTES), truncated: true, totalBytes };
}
```

- [ ] **Step 2: Replace the placeholder in Home.tsx**

In `web/src/components/Home.tsx`, replace the temporary placeholder with the real component:

```tsx
import { SessionInspector } from "./SessionInspector";
// ... inside the component's JSX, replacing the placeholder InspectorPanel children:
<InspectorPanel active={activePanel} onClose={() => setActivePanel(null)}>
  {activePanel?.kind === "session" && (
    <SessionInspector
      sessionId={activePanel.id}
      onSwitchTo={setActivePanel}
      onClose={() => setActivePanel(null)}
      onNotFound={() => {
        setActivePanel(null);
        // Toast "Session no longer available" — see Task 9 for toast wiring;
        // for now alert() is acceptable
        alert("Session no longer available");
      }}
    />
  )}
  {activePanel?.kind === "artefact" && (
    <div style={{ padding: 24 }}>Artefact panel — Task 7</div>
  )}
</InspectorPanel>
```

Wire `onClick` on `SessionTile` and `SessionRow` to `onOpenSession?.(session.id)` (add the prop), and from Home pass `onOpenSession={(id) => setActivePanel({ kind: "session", id })}`.

Concretely, in `Home.tsx`:

- Add a prop `onOpen` to `SessionTileProps` and `SessionRowProps`: `onOpen: (id: string) => void;`
- In `SessionTile`: wrap the `<div className="home-tile">` in a button (`<button type="button" className="home-tile-btn" onClick={() => onOpen(session.id)}>`) or add `onClick={() => onOpen(session.id)}` and `role="button"` `tabIndex={0}` to the existing div. Match how artefact tiles handle this elsewhere — read `Desktop.tsx` for reference.
- Pass `onOpen={(id) => setActivePanel({ kind: "session", id })}` from the map.

- [ ] **Step 3: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Browser-verify**

Run dev. Open Home. Click a `done` session — full transcript appears, header shows state pip + meta, footer Copy buttons work (verify clipboard with Cmd+V into a terminal).

Click a `disconnected` session — banner appears with "Last heartbeat …".

Open a session with touched artefacts → switch to Artefacts tab — see role-chip rows.

Press Escape → panel closes. Click backdrop → panel closes. Click `✕` → panel closes.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SessionInspector.tsx web/src/components/Home.tsx
git commit -m "feat(home): session inspector with transcript + artefacts tabs

Header (state pip, meta, title, started-at), state-conditional banner
(disconnected/waiting), Transcript and Artefacts tabs, footer with
Copy resume command + Copy session ID. Tool-call events render as a
collapsible one-line summary with a 4KB-capped raw JSON expand.

Snapshot-at-open for now; live updates land in the next commit.
Part of #253."
```

---

## Task 6: Live updates with race protection

**Files:**
- Modify: `web/src/components/SessionInspector.tsx`

- [ ] **Step 1: Add SSE subscription with debounce**

Inside `SessionInspector`, add a second `useEffect` after the first one:

```typescript
import { subscribeUiEvents } from "../data/ui-events";

// ... inside component, after the data-fetching useEffect:

useEffect(() => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: AbortController | null = null;

  function refetchLive() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const reqId = ++latestReqId.current;
      if (inflight) inflight.abort();
      inflight = new AbortController();
      Promise.all([
        fetchSession(sessionId, inflight.signal),
        fetchSessionEvents(sessionId, inflight.signal),
      ])
        .then(([s, ev]) => {
          if (reqId !== latestReqId.current) return;
          setSession(s);
          setEvents(ev);
        })
        .catch((err) => {
          // Only surface non-abort errors; refresh failures shouldn't blow up
          // the panel — the user still has the snapshot.
          if (inflight?.signal.aborted) return;
          if (err instanceof SessionNotFoundError) {
            onNotFound();
          }
          // else swallow — log to console for debugging
          console.warn("[SessionInspector] live refresh failed:", err);
        });
    }, 200);
  }

  const unsubscribe = subscribeUiEvents((event) => {
    if (
      event.command === "session_changed"
      && (event.payload as { id?: string } | null)?.id === sessionId
    ) {
      refetchLive();
    }
  });

  return () => {
    if (timer) clearTimeout(timer);
    if (inflight) inflight.abort();
    unsubscribe();
  };
}, [sessionId, onNotFound]);
```

Note: this re-fetches session + events on each event, but NOT artefacts (touched artefacts list rarely changes mid-session and the Artefacts tab isn't usually open during streaming).

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Browser-verify live update**

Run dev. Open the inspector on an `active` session in another claude-code instance you're using right now (or start one).

In the claude session, send a message. Within ~1–2 seconds, the new turn should appear in the transcript without the user clicking anything. The state pip should also reflect any state change (active → done when claude exits).

Burst test: send 3–4 messages rapidly. Open browser dev tools network tab — you should see 1 batched refetch per ~200ms window, not 3–4 separate refetches.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/SessionInspector.tsx
git commit -m "feat(home): live transcript updates over SSE

SessionInspector subscribes to the existing session_changed event via
the shared subscribeUiEvents channel (no new EventSource). Refetches
session + events on each event, gated by:
- Trailing-edge 200ms debounce — coalesces JSONL-burst events into a
  single refetch
- AbortController — cancels in-flight refetches when the panel target
  changes or the panel closes
- latestReqId guard — discards out-of-order responses

Mirrors the useSessions hook's race-protection pattern. Part of #253."
```

---

## Task 7: ArtefactInspector

**Files:**
- Create: `web/src/components/ArtefactInspector.tsx`
- Modify: `web/src/components/Home.tsx` (replace TODO placeholder, wire artefact tile clicks)

- [ ] **Step 1: Create the component**

Create `web/src/components/ArtefactInspector.tsx`:

```typescript
import { useEffect, useState, useRef } from "react";
import { fetchSessionsForArtifact } from "../data/artifacts-api";
import type { SessionJoinedForArtifact } from "../data/sessions-api";
import type { Artifact } from "../../../shared/types";
import { KindThumb } from "./KindThumb";
import type { ActivePanel } from "./InspectorPanel";

interface Props {
  artifact: Artifact;
  onSwitchTo: (next: ActivePanel) => void;
  onClose: () => void;
  onOpen: (artifact: Artifact) => void;
}

export function ArtefactInspector({ artifact, onSwitchTo, onClose, onOpen }: Props) {
  const [sessions, setSessions] = useState<SessionJoinedForArtifact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    const id = ++reqId.current;
    setSessions(null);
    setError(null);
    const ac = new AbortController();
    fetchSessionsForArtifact(artifact.id, ac.signal)
      .then((rows) => {
        if (id !== reqId.current) return;
        setSessions(rows);
      })
      .catch((err) => {
        if (id !== reqId.current || ac.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => ac.abort();
  }, [artifact.id]);

  function copyId() {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(artifact.id).then(() => {
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 1500);
    });
  }

  return (
    <>
      <header className="inspector-header">
        <div className="inspector-meta">
          {artifact.spaceId && <span className="space">{artifact.spaceId}</span>}
          {artifact.spaceId && <span>·</span>}
          <span>{artifact.artifactKind}</span>
          <span className="close" onClick={onClose}>✕</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 12 }}>
          <KindThumb kind={artifact.artifactKind} size={64} />
          <div style={{ minWidth: 0 }}>
            <div className="inspector-title">{artifact.label}</div>
            <div className="inspector-sub">
              {artifact.id}
              {artifact.sourceLabel && ` · ${artifact.sourceLabel}`}
            </div>
          </div>
        </div>
      </header>
      <div className="inspector-body">
        <div className="inspector-section-label" style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--accent-bright)", marginBottom: 12 }}>
          Sessions that touched this
        </div>
        {error && <div className="inspector-error">Couldn't load sessions: {error}</div>}
        {!error && sessions === null && <div className="inspector-empty">Loading…</div>}
        {!error && sessions !== null && sessions.length === 0 && (
          <div className="inspector-empty">No sessions have touched this artefact.</div>
        )}
        {!error && sessions && sessions.length > 0 && sessions.map((row) => (
          <div
            key={row.id}
            className="link-row"
            onClick={() => onSwitchTo({ kind: "session", id: row.session.id })}
          >
            <div className="link-thumb">{row.session.agent[0].toUpperCase()}</div>
            <div className="link-body">
              <div className="link-title">{row.session.title ?? "(no title)"}</div>
              <div className="link-meta">
                <span className={`role-chip ${row.role}`}>{row.role}</span>
                <span>{row.session.agent}</span>
                <span>{formatRel(row.whenAt)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
      <footer className="inspector-footer">
        <button type="button" className="btn primary" onClick={() => onOpen(artifact)}>
          Open
        </button>
        <button type="button" className="btn" onClick={copyId}>
          {copiedId ? "Copied!" : "Copy artefact ID"}
        </button>
      </footer>
    </>
  );
}

function formatRel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
```

- [ ] **Step 2: Wire ArtefactInspector into Home**

In `Home.tsx`, replace the `Artefact panel — Task 7` placeholder. Home already has `desktopProps.artifacts` (the array of all artefacts visible). The ArtefactInspector needs the full Artifact object, so resolve from that array:

```tsx
{activePanel?.kind === "artefact" && (() => {
  const artifact = effectiveDesktopProps.artifacts.find((a) => a.id === activePanel.id);
  if (!artifact) {
    // Artefact may have been archived between the click and the panel render
    setActivePanel(null);
    return null;
  }
  return (
    <ArtefactInspector
      artifact={artifact}
      onSwitchTo={setActivePanel}
      onClose={() => setActivePanel(null)}
      onOpen={(a) => {
        setActivePanel(null);
        desktopProps.onArtifactOpen?.(a); // existing handler from App.tsx
      }}
    />
  );
})()}
```

If `desktopProps.onArtifactOpen` doesn't exist as a typed prop yet, search Home.tsx and Desktop.tsx for the pattern that handles artifact tile clicks today and wire through that.

- [ ] **Step 3: Wire artefact-tile clicks**

Find where artefact tiles render inside Home (the existing `<Desktop>` or its tile components). Add an `onClick` (or override the existing one) so it calls `setActivePanel({ kind: "artefact", id })` instead of (or in addition to) the existing open behaviour.

The simplest path: keep the existing "Open" behaviour for double-click or a context-menu action, and use single-click to open the inspector. But that's a UX change.

**Simpler v1 decision (auto-resolve):** single-click opens the inspector; the inspector's "Open" button then performs the legacy open. This matches the spec's "preview is shallow → Open button does what existing tile click did".

Wire by overriding the prop chain: where Home renders `<Desktop>` (or its tile children), pass an `onArtifactClick` prop that calls `setActivePanel({ kind: "artefact", id })` instead of the original handler. Reference the existing prop interface — `Desktop` likely accepts `onArtifactOpen`. If it has only one click prop, this swap is the change.

- [ ] **Step 4: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Browser-verify**

Click a session tile → SessionInspector opens. Switch to Artefacts tab. Click an artefact row → panel content swaps to ArtefactInspector showing that artefact's metadata + a list of sessions including the one we came from.

Click that session row in the artefact's Sessions list → panel swaps back to SessionInspector for the original session.

Click a regular artefact tile on Home → ArtefactInspector opens.

Click "Open" in ArtefactInspector footer → panel closes AND the existing artefact open flow runs (viewer window appears for non-app, app launches for apps).

- [ ] **Step 6: Commit**

```bash
git add web/src/components/ArtefactInspector.tsx web/src/components/Home.tsx
git commit -m "feat(home): artefact inspector with linked sessions

Metadata header (icon, title, kind, space, source) + linked Sessions
list (cross-navigates back to the session inspector) + footer with
Open (delegates to existing artefact open flow) and Copy artefact ID.

Cross-navigation between session ↔ artefact inspectors keeps the
shell mounted; only the inner inspector remounts. Part of #253."
```

---

## Task 8: Empty/error edge cases

**Files:**
- Modify: `web/src/components/SessionInspector.tsx`
- Modify: `web/src/components/ArtefactInspector.tsx`

Most edge cases are already handled in Tasks 5–7. This task verifies and tightens them.

- [ ] **Step 1: Verify the spec's error matrix**

Walk through the spec's "Error handling" table and confirm each scenario:

| Scenario | Where handled | Verify |
|---|---|---|
| Fetch fails | `setError(err.message)` in initial fetch effect (SessionInspector) | Stop the dev server briefly while inspector is open → reopen with server back → check error renders |
| Session 404 | `SessionNotFoundError` → `onNotFound()` → close + alert | Open inspector with a fake URL or delete a session in DB |
| Empty transcript | "No transcript yet. Live updates active." in `Transcript` empty branch | Open a brand-new session before any events stream in |
| Empty artefacts | "No artefacts touched yet." in `Artefacts` empty branch | Open any session with no `session_artifacts` rows |
| Empty sessions for artefact | "No sessions have touched this artefact." | Open a manually-created artefact never touched by an agent |
| Tool call w/ empty text | One-line summary + click-to-expand | Open a session that contains an `Edit` tool call |
| Clipboard unavailable | `alert()` fallback in `copyCommand` | Hard to reproduce locally; code-review the fallback path |

If any scenario doesn't render the expected text, fix it inline and re-test.

- [ ] **Step 2: Edge-case fix — race when activePanel cleared mid-fetch**

In `Home.tsx`, the `effectiveDesktopProps.artifacts.find` lookup runs every render. When an artefact is archived from the desktop while the inspector is open on it, `find` returns undefined — we early-return null and call `setActivePanel(null)` from inside the render. That's a setState-in-render anti-pattern. Refactor to a `useEffect`:

```typescript
// Inside Home.tsx
const activeArtefact = activePanel?.kind === "artefact"
  ? effectiveDesktopProps.artifacts.find((a) => a.id === activePanel.id)
  : null;

useEffect(() => {
  if (activePanel?.kind === "artefact" && !activeArtefact) {
    setActivePanel(null);
  }
}, [activePanel, activeArtefact]);
```

And in the JSX:

```tsx
{activePanel?.kind === "artefact" && activeArtefact && (
  <ArtefactInspector
    artifact={activeArtefact}
    onSwitchTo={setActivePanel}
    onClose={() => setActivePanel(null)}
    onOpen={(a) => {
      setActivePanel(null);
      // existing open handler
    }}
  />
)}
```

- [ ] **Step 3: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add web/src/components/Home.tsx
git commit -m "fix(home): handle artefact disappearing while inspector is open

Move the active-artefact resolution to render-time + useEffect for
cleanup, so we don't call setState during render when an artefact is
archived from under an open ArtefactInspector. Part of #253."
```

---

## Task 9: Manual QA matrix + final polish

**Files:** none (verification only) unless issues are found.

- [ ] **Step 1: Run full QA matrix from the spec**

For each, perform the action in a fresh dev server with realistic data:

- [ ] Open a `done` session — full transcript renders without error
- [ ] Open an `active` session; trigger a turn from a real `claude` instance — new turn appears within ~1.5s
- [ ] Open a `disconnected` session — banner shows last-heartbeat; Copy resume command copies `claude-code --resume <id>`; verify by pasting in a terminal
- [ ] Open a session with touched artefacts — Artefacts tab shows them with role chips
- [ ] Click a row in Artefacts tab — panel swaps to artefact inspector with same artefact
- [ ] Click a row in artefact's Sessions list — panel swaps back to a session
- [ ] Press Escape, click backdrop, click ✕ — all three close the panel
- [ ] Open inspector while scoped to Tokinvest space — only Tokinvest sessions clickable
- [ ] Open inspector on a session with a known-large tool-call event — verify the click-to-expand shows truncation message at 4KB
- [ ] Open inspector on the same session twice in a row — verify no console errors and no orphan EventSource connections (DevTools → Network → EventStream)

- [ ] **Step 2: Run final type-check and build**

```bash
cd web && npm run build
cd ../server && npm run build
```

Expected: both succeed without warnings.

- [ ] **Step 3: Update CHANGELOG**

Add an entry under `[Unreleased]` in `CHANGELOG.md`:

```markdown
### Added
- **Session inspector.** Click a session tile (or row) to open a slide-panel inspector with the live transcript, the artefacts the agent touched, and a "Copy resume command" button for picking the conversation back up in your terminal. Disconnected sessions show a banner with the last heartbeat. Click an artefact to see which sessions touched it. ([#253](https://github.com/mattslight/oyster/issues/253))
```

Then regenerate the changelog page:

```bash
npm run build:changelog
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md docs/changelog.html
git commit -m "docs(changelog): session inspector

Adds the user-facing summary for the slide-panel inspector. Refresh of
docs/changelog.html via npm run build:changelog."
```

- [ ] **Step 5: Push branch and open PR**

```bash
git push -u origin feat/session-inspector
gh pr create --title "feat(home): session inspector slide-panel" --body "$(cat <<'EOF'
## Summary

- Right-anchored slide-panel inspector for sessions and artefacts (#253)
- Sessions: state pip + banner, Transcript tab (live-updating over SSE), Artefacts tab, Copy resume command + Copy session ID footer
- Artefacts: metadata header + linked Sessions list + Open + Copy ID
- Cross-navigation between session ↔ artefact inspectors keeps the shell mounted

## Closes / refs

- Closes #253 (Inspector panel: session transcript, files, artefacts)
- Follow-ups: #270 (Summary tab), #271 (Files tab), #272 (Memory tab) — deliberately scoped out of this PR

## Test plan

- [ ] Open a `done` session — full transcript renders
- [ ] Open an `active` session — new turns stream in
- [ ] Open a `disconnected` session — banner; Copy resume command works
- [ ] Open session → Artefacts tab → click row → artefact panel
- [ ] Open artefact → Sessions list → click row → session panel
- [ ] Escape / backdrop / ✕ all close
- [ ] Tokinvest space scope respected when opening from a scoped grid
- [ ] Tool-call event shows expandable JSON, capped at 4KB
- [ ] No orphan EventSource in DevTools

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Notes for the executor

- The codebase has no test framework. Don't add Jest/Vitest as part of this PR — that's a separate, contentious decision. Verification = type-check + targeted browser/curl scenarios.
- Match the existing convention of inline-importing helpers (e.g., `formatRel` is duplicated in two inspector files in this plan; that's a deliberate v1 choice over premature extraction. Keep change surface minimal.)
- The `subscribeUiEvents` mechanism already gives single-EventSource semantics — don't create a new EventSource.
- The `latestReqId` race-protection pattern is the codebase's idiom (see `useSessions`). Use it everywhere a fetch is in flight.
- All four new server endpoints reject non-local origins via the existing `rejectIfNonLocalOrigin()` helper. Don't skip that — the data is private.
- Commit at the end of each task, not at the end of the PR — frequent commits give the user clear review points.

