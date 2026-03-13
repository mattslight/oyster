# Oyster OS — Design Document

**Date:** 2026-03-12
**Updated:** 2026-03-13
**Status:** Approved
**Authors:** Matthew Slight, with architectural input from Bharat Mani Prem Sankar

---

## Problem

People's thinking, work and context are fragmented across ChatGPT, Claude, Notion, email, docs, task tools, whiteboards and CRMs. No single tool captures intent, structures it, and renders it into whatever form is needed. Every tool forces you to choose the format first. This starts with thought first.

## Product

Oyster is a hosted web app built around a visual surface. The user sees generated outputs — documents, presentations, mind maps, apps — as icons on an ambient surface, with a unified chat bar for talking to the AI. The bar is the single entry point: chat to build, search to find, type to navigate. Each output replaces a separate tool.

The engine for the PoC is OpenCode (`opencode serve`) running inside a hosted user runtime. Product behaviour is primarily steered by `.opencode/agents/oyster.md`. The user never sees OpenCode, terminals, or code — the engine is invisible.

**One-liner:** Ditch the tools. Use AI like a pro — to write, to present, to build, to visualise.

---

## Architectural Principles

1. The surface is the primary user interface. Artifacts are the product.
2. Chat is embedded in the surface, not a separate window to manage.
3. Zero chrome — no titlebars, taskbars, minimize buttons, or window management for chat. Only artifact viewers use window frames.
4. Oyster system data uses a fixed central schema.
5. App-specific data is local to the user runtime and created only when needed.
6. Static outputs are files, not mini-apps with unnecessary persistence.
7. The UI reads Oyster system data directly.
8. OpenCode is the execution engine for the PoC, not the sole product surface.
9. The engine is invisible — users never see OpenCode, terminals, or code.
10. The surface evolves as the user creates.

---

## PoC Goal

Prove that Oyster can:

1. Present a visual surface where generated outputs appear as typed icons.
2. Accept chat input via an embedded bar and structure it into persistent Oyster system data (nodes, edges).
3. Generate usable outputs that appear on the surface without the user touching code.
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

### Web UI — The Surface

The UI is a visual surface with an embedded chat bar. Artifacts are icons on the surface. Chat is a bar at the bottom, not a floating window.

```
┌─────────────────────────────────────────────────┐
│                                          12:34  │
│                                                  │
│   [Wireframe]  [Deck]  [Mind Map]  [Notes]      │
│                                                  │
│          (Aurora animated background)            │
│                                                  │
│      ┌─────────────────────────────────┐        │
│      │ 🦪  Talk to Oyster...        ↑ │        │
│      └─────────────────────────────────┘        │
└─────────────────────────────────────────────────┘
```

**The surface:**
- Artifact icons in a grid, typed and colour-coded (wireframe, deck, map, notes, app — each with distinct colour/icon/badge)
- New artifacts appear in real time as they're generated
- Background: Aurora WebGL animated gradient (ogl library). Subtle, ambient, alive.
- Fade-in animations when artifacts appear
- Clock in top-right corner

**The chat bar:**
- Persistent input bar at the bottom-centre of the surface
- Contains: Oyster icon, text input, send button
- Glass-effect background with backdrop blur
- When a conversation is active, a messages panel expands upward showing chat history
- When streaming, the bar shows status text: "thinking...", "creating mind map..."
- The bar is the single interface entry point — no dock, no taskbar, no start button

**The bar as universal input (Sprint 2+):**
- Type a question or instruction → starts a new chat/build session
- Type a name or keyword → surfaces matching past work (search)
- Type a navigation command → changes what's on the surface ("show me all projects")
- One input, multiple intents, zero friction

**Artifact viewer:**
- Click an artifact icon → opens in a viewer window (glassmorphic WindowChrome with iframe)
- The viewer is the only remaining "window" — it makes sense because you're viewing a specific document

**Data model:**
- Trash is cosmetic — deleting an artifact removes it from the surface, but the underlying data (nodes, edges) stays in the knowledge graph

The UI reads from Supabase directly for the artifact list and knowledge graph. It connects to the OpenCode server via HTTP/SSE for chat.

**Design origin:** The visual surface pattern emerged organically from the tokinvest-concept prototype. Sprint 1 initially mimicked desktop OS chrome (floating windows, dock, minimize/maximize) but prototyping revealed this was borrowed decoration that didn't serve user intent. The refined direction strips all chrome and embeds chat directly into the surface.

### Future Vision — Agents on the Surface

Agents are persistent AI workers that live on the surface. Each agent has a mission, produces artifacts over time, and shows live status.

- "Research holiday destinations" → spawns an agent → appears as a living card on the surface
- The agent works autonomously, producing artifacts (hotel comparisons, flight options)
- Click an agent to see its conversation + artifacts
- Some agents are quick one-shots, others are long-running

Agents are a flat list (peers, not hierarchical). The chat bar is how you create and interact with agents.

This is NOT Sprint 1 scope. The current model (artifacts on surface + chat bar) is the foundation that agents layer onto.

---

## Session Model

### PoC: Model A — One Persistent Session

One long-running `opencode serve` process per runtime. Messages are sequential. Context window is managed by the LLM provider. OpenCode persists sessions to SQLite natively.

No concurrency. One session, one user, sequential messages.

### Production: Model B — Fresh Sessions, Shared Workspace

Each conversation spawns a fresh session on the same OpenCode server operating on the same persistent workspace (filesystem + local Postgres). `.opencode/agents/oyster.md` and the file system provide continuity between sessions.

Concurrency: one active session per user runtime. Messages are queued. Parallel sessions are explicitly out of scope until a locking strategy exists.

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
- Web UI only (chat bar on surface)

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

**Sprint 1: UI Mockup (pure frontend).** Build the surface, chat bar, artifact viewer — with fake data. No backend. Prove the UX feels right.

**Sprint 2: Wire the Engine.** Embed OpenCode terminal in the surface, connect Supabase for data, real artifact generation with realtime updates.

**Sprint 3+: Polish.** Agents, project/workspace switching, seeded starter artifacts, search, right-click menus.

### Sprint 1 — Build
- [x] Surface with Aurora animated background
- [x] Typed artifact icons on grid (mock data)
- [x] Chat bar embedded at bottom of surface
- [x] Chat messages panel (expands upward from bar)
- [x] Clock in top-right corner
- [x] Artifact viewer window — iframe-based, glassmorphism
- [x] Simulated chat streaming (fake responses for feel)
- [x] Simulated artifact generation (new icon appears on surface)

### Sprint 2 — Build
- [x] OpenCode terminal embedded in surface (xterm.js + WebSocket PTY server)
- [x] Persistent session — survives window close, scrollback replay on reconnect
- [x] Agent config (`.opencode/agents/oyster.md`) — workspace firewall, context awareness
- [x] No minimize — windows are open or closed (iOS model)
- [x] Click-to-focus z-order for windows
- [x] HTTP+WS hybrid server with app process management API
- [x] Real Tokinvest workspace artifacts (2 live apps + 4 static docs)
- [x] App lifecycle: start/stop Vite dev servers, status polling, hero empty state
- [ ] Wire chat bar input to OpenCode session
- [ ] Supabase schema (nodes, edges, artifacts — no RLS for PoC)
- [ ] Supabase realtime subscriptions replacing JSON registry
- [ ] Real artifact generation + appearance on surface

### Prove
- Surface feels like a workspace you return to
- Chat becomes structured nodes and edges
- Oyster can generate at least one static output and one simple app output
- Artifacts appear on the surface without the user touching code
- Agent config-driven behaviour is viable as the main PoC control surface

### Defer
- Auth and provisioning
- Multi-user infra
- Live connectors
- Automated imports and live connectors
- Agents (persistent AI workers on the surface)
- Project/workspace switching
- Bar as universal input (search + navigation)
- Seeded starter artifacts on first use
- Advanced graph visualisation

---

## Open Questions

1. What's the app serving URL pattern for generated apps?
2. Deployment: single VPS (nginx + WS server + OpenCode) or split (static frontend on CDN, WS server on VPS)?
3. How to handle touch device drag (pointer events conflict with touch scrolling)?
