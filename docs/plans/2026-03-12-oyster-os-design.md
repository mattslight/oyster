# Oyster OS — Design Document

**Date:** 2026-03-12
**Updated:** 2026-03-13
**Status:** Approved
**Authors:** Matthew Slight, with architectural input from Bharat Mani Prem Sankar

---

## Problem

People's thinking, work and context are fragmented across ChatGPT, Claude, Notion, email, docs, task tools, whiteboards and CRMs. No single tool captures intent, structures it, and renders it into whatever form is needed. Every tool forces you to choose the format first. This starts with thought first.

## Product

Oyster is a hosted web app that looks and feels like a personal desktop operating system. The user sees a visual surface of generated outputs — documents, presentations, mind maps, apps — with chat as a floating window on that desktop. Each output replaces a separate tool.

The engine for the PoC is OpenCode (`opencode serve`) running inside a hosted user runtime. Product behaviour is primarily steered by `.opencode/agents/oyster.md`. The user never sees OpenCode, terminals, or code — the engine is invisible.

**One-liner:** Ditch the tools. Use AI like a pro — to write, to present, to build, to visualise.

---

## Architectural Principles

1. The desktop surface is the primary user interface. Artifacts are the product.
2. Chat is a tool on the desktop, not the product itself. Conversations are windows.
3. Oyster system data uses a fixed central schema.
4. App-specific data is local to the user runtime and created only when needed.
5. Static outputs are files, not mini-apps with unnecessary persistence.
6. The UI reads Oyster system data directly.
7. OpenCode is the execution engine for the PoC, not the sole product surface.
8. The engine is invisible — users never see OpenCode, terminals, or code.
9. UIs are not static — the desktop evolves as the user creates.

---

## PoC Goal

Prove that Oyster can:

1. Present a desktop surface where generated outputs appear as typed icons.
2. Accept chat input via a floating window and structure it into persistent Oyster system data (nodes, edges).
3. Generate usable outputs that appear on the desktop without the user touching code.
4. Feel like a workspace you return to, not a chat thread you scroll.

---

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────┐
│            Central (Supabase)                    │
│                                                  │
│  oyster schema (all users, RLS)                  │
│  ├── nodes                                       │
│  ├── edges                                       │
│  └── artifacts                                   │
│                                                  │
│  Auth (Supabase Auth)                            │
│  User registry                                   │
└────────────────────┬────────────────────────────┘
                     │ DATABASE_URL
                     │
┌────────────────────▼────────────────────────────┐
│           User Container / VM                    │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │  opencode serve (port 4096)              │   │
│  │  REST API + SSE streaming                │◄──┼── HTTP/SSE ──► Clients
│  │  ├── POST /session                       │   │
│  │  ├── POST /session/{id}/message          │   │
│  │  ├── GET  /event (SSE stream)            │   │
│  │  └── GET  /file/* (static serving)       │   │
│  └──────────────┬───────────────────────────┘   │
│                 │                                │
│  ┌──────────────▼──┐  ┌───────────┐  ┌────────────┐  │
│  │/workspace       │  │/apps      │  │Local       │  │
│  │ .opencode/      │  │ (generated│  │Postgres    │  │
│  │   agents/       │  │  outputs) │  │(app data   │  │
│  │ docs/           │  │           │  │ only)      │  │
│  │ data/           │  │           │  │            │  │
│  └─────────────────┘  └───────────┘  └────────────┘  │
└─────────────────────────────────────────────────┘
```

### Central Database (Supabase) — Fixed Schema

The Oyster system data lives centrally. One migration updates all users. UI and clients query this directly without going through OpenCode.

The central schema is a fixed product contract, optimised for reliable UI querying and broad semantic flexibility rather than exhaustive type-specific modelling.

```sql
-- Core knowledge graph
nodes (
  id uuid primary key,
  user_id uuid references auth.users,
  type text,              -- person, task, idea, project, note, meeting, etc.
  title text,
  content text,
  metadata jsonb,         -- type-specific fields (email, status, due_date, etc.)
  source_type text,       -- chat, import, connector, system
  created_at timestamptz,
  updated_at timestamptz
)

-- Relationships between nodes
edges (
  id uuid primary key,
  user_id uuid references auth.users,
  source_node_id uuid references nodes,
  target_node_id uuid references nodes,
  relationship text,      -- works_with, blocked_by, part_of, mentioned_in, etc.
  metadata jsonb,
  source_type text,       -- chat, import, connector, system
  created_at timestamptz
)

-- Registry of generated outputs
artifacts (
  id uuid primary key,
  user_id uuid references auth.users,
  name text,
  type text,              -- mindmap, document, app, diagram, slides, etc.
  path text,              -- filesystem path on the VM
  node_id uuid references nodes,  -- optional: linked to a node
  status text,            -- generating, ready, failed
  metadata jsonb,
  created_at timestamptz
)
```

**RLS on all tables:** `user_id = auth.uid()`

**PoC simplification:** No user_id columns, no RLS, no auth. Single user.

### Local Database (Per-Container Postgres) — App Data Only

When OpenCode generates an app that needs persistent data (e.g. a todo tracker, a CRM), it creates a schema in local Postgres for that app. Static outputs (presentations, mind maps, diagrams) don't get a database — they're just files.

```
One Postgres instance, one database
├── schema: app_kps_todo      ← OpenCode created and manages this
├── schema: app_deal_tracker  ← OpenCode created and manages this
└── (no schema for static outputs)
```

**Firewall:** OpenCode can access both central and local Postgres. The UI only accesses central Supabase. Local app schemas are only accessed by their generated app frontends.

### OpenCode Server (Engine)

`opencode serve` runs on the user's VM and exposes a comprehensive REST API on port 4096. This is the invisible engine that powers all chat interactions and output generation.

Key endpoints:
- `POST /session` — create a new session
- `POST /session/{id}/message` — send a user message
- `GET /event` — SSE stream for real-time events (assistant responses, tool use, status)
- `GET /session` — list sessions
- `GET /file/*` — serve files from the workspace
- `GET /mcp` — list MCP servers
- `POST /mcp/{name}/connect` — connect an MCP server
- `PATCH /config` — update configuration (provider, model, etc.)
- `GET /doc` — OpenAPI 3.1 spec for typed client generation

The frontend connects to OpenCode via HTTP for sending messages and SSE (EventSource API) for receiving streaming responses. No WebSocket layer, no Node.js bridge, no stdin/stdout piping.

A thin proxy layer (e.g. nginx or a small Express server) may sit in front of `opencode serve` to handle CORS headers and auth token injection. If OpenCode's CORS support proves sufficient, the frontend can hit the API directly.

### OpenCode Agent Config — Product Conventions

Defines a major part of Oyster's behaviour and conventions via `.opencode/agents/oyster.md`. This file uses YAML frontmatter per OpenCode's agent spec and is the primary product control surface in the PoC. The product also includes the fixed schema contract, the workspace conventions, the artifact serving model and the UI.

Key sections:

- **Identity:** "You are Oyster. You help the user capture, structure, and visualise their thinking."
- **Knowledge conventions:** Always structure input into the Oyster system data (nodes + edges in Supabase). Check if a node exists before creating duplicates. Use node types and relationship types flexibly.
- **App generation:** Generated apps go in /apps/<app-name>/. Each is a standalone static site or React app. Apps that need data get a local Postgres schema. Report the served URL after generation.
- **Output conventions:** Defined per output type. Sprint 1 focuses on documents (Markdown), mind maps (interactive HTML) and simple app generation.
- **Data rules:** Oyster system data is in Supabase (connection string from env). App-specific data is in local Postgres. Never mix them.

OpenCode supports custom agent markdown files natively via `.opencode/agents/`. No special tooling needed.

### Web UI — Desktop OS Surface

The UI is a desktop operating system metaphor. Artifacts are desktop icons. Chat is a floating window.

```
┌─────────────────────────────────────────────────┐
│                                                  │
│   [Wireframe]  [Deck]  [Mind Map]  [Notes]      │
│                                                  │
│          ┌─────────────────────┐                 │
│          │ Chat Window         │                 │
│          │ ─────────────────── │                 │
│          │ You: make me a map  │                 │
│          │ Oyster: Creating... │                 │
│          │                     │                 │
│          │ [Talk to Oyster...] │                 │
│          └─────────────────────┘                 │
│                                                  │
├──────────────────────────────────────────────────┤
│ 🟢 Oyster  │ [💬 Creating mind map...]  │ LOCAL │
└──────────────────────────────────────────────────┘
```

**Desktop surface:**
- Artifact icons in a grid, typed and colour-coded (wireframe, deck, map, notes, app — each with distinct colour/icon/badge)
- New artifacts appear here in real time as they're generated
- Background: subtle gradient with dot grid (like tokinvest prototype)
- Fade-in animations when artifacts appear

**Chat as windows:**
- Conversations are floating windows on the desktop, like OS app windows
- Open via the Oyster button in the taskbar
- Can be minimized to the taskbar
- When minimized, show a status ticker: "thinking...", "writing presentation...", streaming preview text

**Artifact viewer:**
- Click an artifact icon → opens in a viewer window (same window system as chat)
- Different renderers per type: iframe for HTML apps/maps/wireframes, markdown renderer for notes

**Taskbar:**
- Bottom bar with Oyster branding, minimized window chips with status text, status dot, clock
- The Oyster button opens a new chat window

**Data model:**
- Trash is cosmetic — deleting an artifact removes it from the desktop, but the underlying data (nodes, edges) stays in the knowledge graph
- Auto-hygiene (future): old/idle chats automatically archive to a "Chat History" icon on the desktop

The UI reads from Supabase directly for the artifact list and knowledge graph. It connects to the OpenCode server via HTTP/SSE for chat.

**Design origin:** This metaphor was validated organically — while building tokinvest-concept, the same artifact-browser-as-desktop pattern emerged naturally as the best way to navigate AI-generated outputs. The desktop metaphor is universal: familiar to older users (Windows/Mac desktop), familiar to younger users (iOS app grid).

---

## Session Model

### PoC: Model A — One Persistent Session

One long-running `opencode serve` process per runtime. Messages are sequential. Context window is managed by the LLM provider. OpenCode persists sessions to SQLite natively.

No concurrency. One session, one user, sequential messages. One chat window at a time.

### Production: Model B — Fresh Sessions, Shared Workspace

Each conversation spawns a fresh session on the same OpenCode server operating on the same persistent workspace (filesystem + local Postgres). `.opencode/agents/oyster.md` and the file system provide continuity between sessions.

Concurrency: one active session per user runtime. Messages are queued. Parallel sessions and multiple simultaneous chat windows are explicitly out of scope until a locking strategy exists.

---

## LLM Flexibility

OpenCode supports 75+ LLM providers out of the box, making Oyster provider-agnostic at the engine level.

- **PoC:** Use Anthropic (Claude) as the default provider
- **Production:** Users can bring their own API key for any supported provider (OpenAI, Anthropic, Google Gemini, local Ollama, etc.)
- **Configuration:** Provider and model settings via `PATCH /config` endpoint or `.opencode/config` file
- **Implication:** Oyster's value is in the product layer (knowledge graph, conventions, UI), not in any specific LLM

---

## Input Channels

### PoC
- Web UI only (chat window on desktop)

### Roadmap
- Telegram bot
- WhatsApp (via WhatsApp Business API)
- All channels hit the same HTTP/SSE API layer on the user's container

```
Web UI ──────┐
Telegram ────┼──► API layer ──► OpenCode server
WhatsApp ────┘
```

---

## Data Ingestion Roadmap (Not PoC)

### Phase 1: Imports (file-based, user-initiated)

| Source | Method |
|--------|--------|
| ChatGPT | Export conversations.json, ingest |
| Claude | Export via memory prompt, ingest |
| Perplexity | Manual export from Library, ingest |
| Documents | Upload/paste files directly |

On import, Oyster can auto-generate starter artifacts (summaries, knowledge maps) so the desktop isn't empty. User can trash these — the data persists, only the visual artifact disappears.

### Phase 2: Live connectors (bi-directional sync)

| Connector | Purpose |
|-----------|---------|
| Gmail | Ingest emails, extract entities, tasks, context |
| Outlook | Same as Gmail for Microsoft users |
| Google Calendar | Time awareness, meeting context |
| Google Workspace | Docs, Sheets integration |

PoC input is chat only. Imports are sprint 2+. Live connectors are later.

**Note:** OpenCode has native MCP support. Connectors can be implemented as MCP servers, managed via the REST API (`GET /mcp`, `POST /mcp/{name}/connect`).

---

## Provisioning (Production Path)

### Per-user container model

Each user gets an isolated container with:
- OpenCode (`opencode serve`)
- Local Postgres (app data only)
- Persistent volume (filesystem, OpenCode sessions/config, local DB)
- Connection to central Supabase (knowledge graph)

### Signup flow
1. User signs up → Supabase Auth creates account
2. System provisions container from base image
3. Local Postgres initialises (empty, for app data)
4. Container gets persistent volume
5. User connects via HTTP/SSE

### Schema migrations
- Central Supabase schema: one migration, all users updated instantly
- Local app schemas: owned by OpenCode, no fleet-wide migrations needed
- This split is why the central/local separation exists

### PoC constraints to respect for production readiness
- Use `$DATABASE_URL` and `$OYSTER_WORKSPACE` env vars, not hardcoded paths
- Keep `.opencode/agents/oyster.md`, schema migrations, and config in one repo (future Docker image source)
- No user identity in the knowledge graph schema for PoC, but the column is defined for production

---

## PoC Scope

### Sprint Strategy

**Sprint 1: UI Mockup (pure frontend).** Build the desktop surface, chat window, artifact viewer, taskbar — with fake data. No backend. Prove the UX feels right.

**Sprint 2: Wire the Engine.** Connect OpenCode for chat, Supabase for data, real artifact generation with realtime updates.

**Sprint 3+: Polish the OS.** Drag/resize windows, multiple chat windows, auto-hygiene, seeded starter artifacts, right-click menus, folders, search.

### Sprint 1 — Build
- [ ] Desktop surface with typed artifact icons (mock data)
- [ ] Taskbar with Oyster button, minimized window chips, status, clock
- [ ] Chat window — floating, closeable, minimizable with status ticker
- [ ] Artifact viewer window — iframe-based
- [ ] Simulated chat streaming (fake responses for feel)
- [ ] Simulated artifact generation (new icon appears on desktop)

### Sprint 2 — Build
- [ ] OpenCode server setup + `.opencode/agents/oyster.md`
- [ ] Supabase schema (nodes, edges, artifacts — no RLS for PoC)
- [ ] Real chat via HTTP/SSE to OpenCode
- [ ] Supabase realtime subscriptions replacing mock data
- [ ] Real artifact generation + appearance on desktop

### Prove
- Desktop feels like a workspace you return to
- Chat becomes structured nodes and edges
- Oyster can generate at least one static output and one simple app output
- Artifacts appear on the desktop without the user touching code
- Agent config-driven behaviour is viable as the main PoC control surface

### Defer
- Auth and provisioning
- Multi-user infra
- Live connectors
- Automated imports and live connectors
- Spaces / organisational hierarchy
- Parallel sessions / multiple chat windows
- Drag and resize windows
- Auto-hygiene (chat archival)
- Seeded starter artifacts on first use
- Advanced graph visualisation

---

## Open Questions

1. What's the app serving URL pattern? e.g. `http://vm:4096/file/apps/kps-todo/index.html`
2. How does the frontend handle CORS when hitting `opencode serve` directly?
3. Do we need a thin proxy between frontend and `opencode serve` for auth/CORS, or can OpenCode handle it natively?
4. Should the desktop support spatial memory (user-arranged icon positions) or always auto-grid?
