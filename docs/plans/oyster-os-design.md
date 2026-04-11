# Oyster OS — Design Document

**Status:** Living document
**Last updated:** 2026-03-30
**Authors:** Matthew Slight, with architectural input from Bharat Mani Prem Sankar

---

## Hypothesis

> The right interface for knowledge work is a **surface that connects all your systems, accumulates context over time, and synthesises across boundaries** — so you can ask a question that spans Zoho and ProCore and last month's conversation and get one answer, not three logins.

Not just for makers and developers. For anyone whose work is distributed across more than one system and one session.

**The key test:** can the surface join dots that no single tool, dashboard, or LLM session could?
- A dashboard can't — it's a pre-defined view of one system.
- ChatGPT can't — it has no live access and forgets between sessions.
- A Zoho report can't — ProCore isn't in scope.

Oyster can, because it connects all systems via MCP, holds the relationships between them in a knowledge graph, and accumulates context across every session.

## Problem

People's work is fragmented across systems, projects, and sessions. A construction company's chairman needs to know the health of the sales pipeline — but the answer spans Zoho CRM and ProCore and decisions made last quarter. No single tool sees all of it. No dashboard was pre-built for exactly that question. No LLM session has access to both systems plus the history.

More broadly: each LLM conversation starts from scratch. No tool knows the auth pattern you built in one project conflicts with what you're building in another. No tool remembers the decision you made six months ago. No tool can answer "what should I focus on this week?" from first principles across all your work.

Oyster's surface accumulates context across all your systems and sessions — so your AI partner gets smarter the longer you use it, not just during a single conversation.

## Product

Oyster is a visual surface where generated outputs — documents, diagrams, apps, notes — appear as artifacts you can open, organise, and build on. A unified chat bar is the single entry point: chat to build, search to find, type to navigate. Each output replaces a separate tool.

The engine is OpenCode (`opencode serve`). Persistent memory is Graphiti (a temporal knowledge graph running locally via Docker). Product behaviour is steered by `.opencode/agents/oyster.md`. The user never sees OpenCode or the graph — the engine is invisible.

**One-liner:** A surface that remembers. An AI that connects the dots.

---

## Architectural Principles

1. The surface is the primary user interface. Artifacts are the product.
2. Chat is embedded in the surface, not a separate window to manage.
3. Zero chrome — no titlebars, taskbars, minimize buttons, or window management for chat. Only artifact viewers use window frames.
4. Oyster system data uses a fixed central schema.
5. App-specific data is local to the user runtime and created only when needed.
6. The artifact contract is the stable abstraction. Runtime backends are swappable.
7. The UI reads Oyster system data directly.
8. OpenCode is the execution engine for the PoC, not the sole product surface.
9. The engine is invisible — users never see OpenCode, terminals, or code.
10. The surface evolves as the user creates.
11. Isolate at the tenant boundary, not the artifact boundary. The AI sees all artifacts for one user.

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
┌──────────────────────────────────────────────────────────┐
│                    User Machine (local)                   │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Oyster Server  (port 4200)                         │ │
│  │  ├── HTTP API  (/api/artifacts, /api/spaces, etc.)  │ │
│  │  ├── MCP endpoint  (/mcp/)  ← agent tool surface    │ │
│  │  ├── Chat proxy  → OpenCode                         │ │
│  │  └── SQLite  (userland/oyster.db)                   │ │
│  │       ├── artifacts  (registry, metadata)           │ │
│  │       └── spaces  (nav hierarchy, scan status)      │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌─────────────────┐   ┌──────────────────────────────┐  │
│  │  OpenCode       │   │  Graphiti  (port 8000)        │  │
│  │  (port 4096)    │   │  ├── FalkorDB graph store     │  │
│  │  REST + SSE     │   │  ├── LLM entity extraction    │  │
│  │  .opencode/     │   │  └── MCP endpoint  (/mcp/)   │  │
│  │  agents/        │   │       ├── search_nodes        │  │
│  │  oyster.md      │   │       ├── search_facts        │  │
│  └─────────────────┘   │       ├── add_episode        │  │
│                         │       └── get_episodes       │  │
│                         └──────────────────────────────┘  │
│                                                           │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  React UI  (Vite dev server or static)               │ │
│  │  ├── polls /api/artifacts + /api/spaces              │ │
│  │  └── streams chat via SSE                            │ │
│  └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

**Three systems, three responsibilities:**

| System | Port | Responsibility |
|---|---|---|
| Oyster Server | 4200 | Artifact/space registry (SQLite), MCP tool surface, chat proxy |
| OpenCode | 4096 | AI engine, code execution, filesystem access |
| Graphiti | 8000 | Knowledge graph, persistent memory, cross-session context |

The agent (OpenCode) has MCP access to both Oyster (surface management) and Graphiti (memory). The UI talks only to Oyster Server. Graphiti is invisible to the user.

### The Artifact Contract

The artifact contract is the central abstraction in Oyster's architecture. Every output Oyster creates — a document, a game, a presentation, a full web app — conforms to one contract. The contract is stable; the runtime backend behind it is swappable.

This means the product model does not depend on how artifacts are executed. Today artifacts are served as static files. Tomorrow they could run in Docker containers or Firecracker microVMs. The artifact itself doesn't know or care.

#### Folder structure

Every artifact lives in its own directory:

```
/artifacts/<id>/
├── manifest.json        ← what it is, how to run it, what it needs
├── src/                 ← its files (one HTML file, a Vite project, markdown, etc.)
└── data/                ← its persisted state (if any)
```

#### Manifest schema

```json
{
  "id": "snake-game",
  "name": "Snake Game",
  "type": "app",
  "runtime": "static",
  "entrypoint": "src/index.html",
  "ports": [],
  "storage": "none",
  "capabilities": [],
  "space": "home",
  "status": "ready",
  "created_at": "2026-03-14T10:00:00Z",
  "updated_at": "2026-03-14T10:00:00Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (kebab-case, folder name) |
| `name` | string | Human-readable display name |
| `type` | string | Visual type for surface presentation (see artifact types below) |
| `runtime` | string | How this artifact is executed (see runtime classes below) |
| `entrypoint` | string | Relative path from artifact root to the main file to serve/run |
| `ports` | number[] | Ports this artifact needs (empty for static) |
| `storage` | string | Data persistence needs: `"none"`, `"localstorage"`, `"sqlite"`, `"postgres"` |
| `capabilities` | string[] | Declared capabilities: `"network"`, `"filesystem"`, `"database"`, `"auth"` |
| `space` | string | Which space this artifact belongs to |
| `status` | string | `"generating"`, `"ready"`, `"failed"`, `"online"`, `"offline"`, `"starting"` |
| `created_at` | string | ISO 8601 timestamp |
| `updated_at` | string | ISO 8601 timestamp |

#### Artifact types

The `type` field determines visual presentation on the surface (icon, colour, badge, viewer behaviour). It does not constrain what the artifact can do.

| Type | Badge | Colour | Typical use |
|------|-------|--------|-------------|
| `app` | app | Blue (#60a5fa) | Interactive applications, games, tools, CRUD apps |
| `deck` | deck | Purple (#a78bfa) | Presentations, slide decks (opens fullscreen by default) |
| `map` | map | Green (#4ade80) | Mind maps, information architecture |
| `notes` | notes | Green (#4ade80) | Documents, markdown content, READMEs |
| `diagram` | diagram | Amber (#fbbf24) | Dashboards, architecture diagrams, data visualisations |
| `wireframe` | wireframe | Indigo (#818cf8) | UI wireframes, layout sketches |
| `table` | table | Cyan (#22d3ee) | Spreadsheets, data tables, structured data views |

The type list is extensible. Adding a new type means adding an icon/colour entry in `ArtifactIcon.tsx` — no architectural changes required.

#### Runtime classes

The `runtime` field determines how the artifact is served and executed. Runtime classes are the swappable backend — the artifact contract stays the same regardless of which runtime is used.

| Runtime | What it does | When to use |
|---------|-------------|-------------|
| `static` | Serve files directly via HTTP. No build step, no process. | HTML files, markdown, presentations, diagrams, simple games, spreadsheets |
| `vite` | Run `npm install` + `npx vite` in the artifact's `src/` directory. Manage the process and port. | Full React/TS apps that need a build toolchain |
| `docker` | Build and run a Docker container from a Dockerfile in `src/`. | Apps needing isolated dependencies, different runtimes, or server-side logic |

**Tier 1 (now):** Only `static` is implemented. All artifacts are single HTML files or markdown, served directly.

**Tier 2 (later):** Add `vite` runtime class. The serving layer reads the manifest, sees `runtime: "vite"`, runs the build, manages the process.

**Tier 3 (production):** Add `docker` runtime class. Same manifest, different execution backend.

This is additive. Tier 1 artifacts continue working unchanged when Tier 2 and 3 are added. The manifest is the contract; the runtime is the implementation.

#### What the AI agent sees

OpenCode has full filesystem access to the workspace and can read/modify any artifact's manifest, source files, and data. This is tenant-scoped visibility — the agent sees everything for one user, nothing for other users. This cross-artifact visibility is Oyster's core differentiator: "take the data from the sales dashboard and reference it in the presentation" works because both artifacts are in the same filesystem scope.

**MCP tool surface:** In addition to filesystem access, agents interact with the desktop surface via the Oyster MCP server (`localhost:4200/mcp/`). This is the preferred interface for surface management — it enforces approved paths, maintains the artifact registry, and makes agent intent legible to the system.

| Tool | What it does |
|------|-------------|
| `get_context` | Returns a full description of Oyster OS, artifact kinds, and the userland path |
| `list_spaces` / `list_artifacts` | Discover what exists on the surface |
| `create_artifact` | Write content + register on the surface in one step (opaque UUID id, slug-based filename) |
| `read_artifact` | Read the raw text of a static file artifact |
| `update_artifact` | Update display metadata (label, space, group) without touching the file |
| `register_artifact` | Register a pre-existing file as a desktop artifact |

Agents should use MCP tools for surface management and direct filesystem access for reading/modifying artifact source content. Do not touch `userland/oyster.db` directly.

### SQLite — Artifact and Space Registry

Oyster Server owns a local SQLite database (`userland/oyster.db`) for surface state. This is fast, local, zero-infrastructure.

```sql
artifacts (id, space_id, label, artifact_kind, storage_kind, storage_config,
           runtime_kind, runtime_config, group_name, source_origin, source_ref,
           removed_at, created_at, updated_at)

spaces (id, display_name, repo_path, color, parent_id,
        scan_status, scan_error, last_scanned_at, last_scan_summary,
        created_at, updated_at)
```

`source_origin` tracks how an artifact arrived: `manual` | `discovered` | `ai_generated`.
`parent_id` on spaces is **navigation only** — where to show the space in the UI hierarchy. Semantic relationships between spaces live in the knowledge graph.

### Knowledge Graph — Graphiti

Graphiti runs locally via Docker (FalkorDB backend, MCP endpoint at `localhost:8000`). This is where Oyster's memory lives.

**Model:** Everything is nodes and edges — no separate tables for memories vs spaces.

- **Episodes** — raw input ingested via `add_episode` (conversations, onboarding events, documents)
- **Entity nodes** — extracted by LLM from episodes: `Space`, `Artifact`, `Person`, `Decision`, `Technology`, `Pattern`
- **Fact edges** — typed relationships: `USES`, `CLIENT_OF`, `DEPENDS_ON`, `SHARES_PATTERN`, `HAS_ARTIFACT`, `DECIDED`
- **group_id** — namespace mapping to `space_id` for scoped queries

**Key property:** Space relationships are graph edges, not SQL columns. "Tell me about all my client projects" is a graph traversal over `CLIENT_OF` edges — not a query against a container space. There may be no container space. Relationships emerge as the agent observes and records them.

**Temporal facts:** Graphiti invalidates stale facts when state changes. A decision made last month that's been superseded is marked invalid, not deleted. History is preserved.

### App-Specific Data

Artifacts that need persistence (e.g. a generated todo tracker) use their own local SQLite or browser storage. OpenCode creates and manages this per-artifact. It is separate from Oyster's registry.

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
- **Knowledge graph (Graphiti) — MANDATORY:** At session start, call `search_nodes` to load context. When the user shares facts, decisions, or project info, call `add_episode` immediately. Before answering anything about a person, project, or past work, call `search_nodes` + `search_facts` first. The graph is how Oyster remembers across sessions — without it, the agent is stateless.
- **Artifact generation:** Use `create_artifact` via Oyster MCP. Generated artifacts are registered on the desktop surface automatically. Set `source_origin: 'ai_generated'` for agent-produced content.
- **Output conventions:** The agent infers the correct artifact type from intent — the user describes what they need, not what format to use.
- **Surface management:** Prefer Oyster MCP tools (`create_artifact`, `list_artifacts`, `update_artifact`) over direct filesystem manipulation. The MCP tools keep the registry consistent.

OpenCode supports custom agent markdown files natively via `.opencode/agents/`. No special tooling needed.

### Web UI — The Surface

The UI is a visual surface with an embedded chat bar. Artifacts are icons on the surface. Chat is a bar at the bottom, not a floating window.

```
┌─────────────────────────────────────────────────┐
│                                          12:34  │
│                                                  │
│   [App]  [Deck]  [Mind Map]  [Notes]  [Table]   │
│                                                  │
│          (Aurora animated background)            │
│                                                  │
│      ┌─────────────────────────────────┐        │
│      │   Talk to Oyster...          ↑ │        │
│      └─────────────────────────────────┘        │
└─────────────────────────────────────────────────┘
```

**The surface:**
- Artifact icons in a grid, typed and colour-coded (each type has a distinct colour/icon/badge)
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
- Deck artifacts open fullscreen by default with a draggable light frosted-glass toolbar (universally visible on any content). Toolbar has prev/next navigation, exit fullscreen, and close.
- The viewer is the only remaining "window" — it makes sense because you're viewing a specific document

**Data model:**
- Trash is cosmetic — deleting an artifact removes it from the surface, but the underlying data (nodes, edges) stays in the knowledge graph

The UI polls Oyster Server (`/api/artifacts`, `/api/spaces`) for surface state and streams chat via SSE. It has no direct connection to Graphiti or OpenCode.

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

## Runtime Tiers and Deployment Architecture

This section documents the thinking behind Oyster's runtime and deployment strategy. The goal is to make the right decisions now (artifact contract, tenant-scoped visibility) without over-building infrastructure, while keeping a clear path to multi-tenant production.

### The Core Principle

Build Oyster around artifact contracts and tenant-scoped agent visibility, then swap runtime backends later.

The artifact contract (manifest + folder structure) is the stable abstraction. Everything below it — how files are served, how processes are managed, how apps are isolated — is an implementation detail that changes as Oyster scales through tiers.

### Tier 1: Local Filesystem + Static Serving (Now)

Every artifact gets its own folder and manifest. The only runtime class implemented is `static` — files are served directly via HTTP, rendered in an iframe. No build steps, no process management for generated artifacts.

**What this covers:**
- Documents (markdown, HTML)
- Presentations / slide decks (HTML)
- Mind maps and diagrams (HTML + SVG/Canvas)
- Simple interactive apps and games (HTML + inline JS/CSS)
- Spreadsheets and data tables (HTML + JS)
- Wireframes (HTML)
- Simple websites (HTML + CSS + JS)

**Isolation model:** Browser iframe sandboxing. Each artifact runs in a separate JS context with no DOM access to the parent surface. This is how CodePen, JSFiddle, and Observable work — it's not a hack, it's a standard and well-understood isolation boundary.

**Data persistence for simple artifacts:** `localStorage` or IndexedDB within the iframe. For more capable in-browser persistence, SQLite compiled to WebAssembly (sql.js) runs entirely client-side. No server infrastructure needed.

**What this doesn't cover:** Multi-file projects needing a build toolchain (React/TS apps), server-side logic, or artifacts that need their own database.

**Design-for-Tier-2 now:** Even though Tier 1 only uses `static`, every artifact gets the full manifest with `runtime`, `storage`, `capabilities`, and `ports` fields. These fields are unused today but mean the serving layer can dispatch to different runtime backends without changing the artifact model.

### Tier 2: Full Project Runtimes (Pre-Launch)

Add the `vite` runtime class. When a user asks for something that needs a build toolchain — a full React app, a multi-page site with TypeScript — the agent creates an artifact with `runtime: "vite"` and the serving layer handles the rest.

**What changes:**
- `npm install` + `npx vite` per artifact, managed by the Oyster server process manager
- Dynamic port allocation from the manifest's `ports` field
- Process lifecycle management (start, stop, health check, restart on crash)
- Artifacts with `storage: "postgres"` get a local Postgres schema

**What doesn't change:**
- The artifact contract (same manifest, same folder structure)
- Tier 1 `static` artifacts (they keep working as before)
- The agent's view of the filesystem (still sees all artifacts)

**Infrastructure cost:** Process management, port allocation, npm install times. This is the current `registry.json` + `process-manager.ts` pattern generalised to work from manifests instead of a hand-curated registry.

### Tier 3: Containerised Runtimes (Multi-Tenant Production)

Add the `docker` runtime class. For artifacts that need isolated dependencies, different language runtimes, or untrusted code execution.

**Options evaluated:**

| Technology | What it is | When it's relevant |
|------------|-----------|-------------------|
| **Docker Compose** | Define and run multi-container applications from one YAML config. Each artifact with `runtime: "docker"` gets its own container with declared ports and volumes. | First step beyond process isolation. Reasonable for managed single-user or small multi-tenant deployments. |
| **gVisor** | Google's container sandbox. Intercepts system calls to provide stronger isolation than standard Docker without the overhead of a full VM. Used by Google Cloud Run. | Middle ground between Docker and full VM isolation. Good if you need untrusted code execution without microVM complexity. |
| **Kata Containers** | Lightweight VMs that run containers inside per-container virtual machines. Stronger isolation than gVisor, lighter than traditional VMs. | Similar use case to Firecracker but with a more standard container workflow. |
| **Firecracker** | AWS's microVM technology. KVM-based virtual machines with ~125ms boot time and ~5MB memory overhead per VM. Powers Lambda and Fargate. | Strongest isolation with surprisingly low overhead. Relevant if Oyster becomes a managed platform running user workloads on shared hosts. What Fly.io uses under the hood. |
| **Kubernetes** | Container orchestration across multiple machines. Auto-scaling, service discovery, rolling deployments. | Overkill unless Oyster is running hundreds of containers across a cluster. Not relevant for single-host or small-scale deployment. |

**Recommendation:** Start with Docker Compose. Move to Firecracker or gVisor only when multi-tenant untrusted code execution becomes a real security requirement. Do not use Kubernetes unless operating at significant scale across multiple machines.

### Deployment Models

How does Oyster deploy as a product? There are several models, and the artifact contract supports all of them because the product boundary (manifests, folder structure, agent visibility) is independent of the deployment boundary.

#### Model A: Single Machine (PoC, Power Users)

Everything runs on one machine — the surface, OpenCode, generated artifacts, the database. This is the current state and is correct for the PoC.

```
┌─────────────── One Machine ──────────────┐
│  Oyster Surface (web UI)                 │
│  Oyster Server (artifact serving, proxy) │
│  OpenCode (AI engine)                    │
│  /artifacts/ (all generated outputs)     │
│  Postgres (knowledge graph + app data)   │
└──────────────────────────────────────────┘
```

Also the model for power users who want to self-host and modify Oyster locally. The upgrade path is theirs to manage.

#### Model B: Control Plane + Distributed Runtimes

Separate what's shared (UI, auth, billing) from what's per-tenant (AI engine, artifacts, data).

```
┌── Control Plane (SaaS, one deployment) ──┐
│  Oyster Surface (React app on CDN)       │
│  Auth / Billing / User management        │
│  Tenant router                           │
│  Runtime version manager                 │
└────────────────┬─────────────────────────┘
                 │
    ┌────────────▼────────────┐
    │  Oyster Runtime (per    │
    │  tenant, versioned      │
    │  image)                 │
    │                         │
    │  OpenCode               │
    │  /artifacts/            │
    │  Postgres               │
    │  Artifact runtimes      │
    └─────────────────────────┘
```

**Control Plane** is a conventional SaaS backend deployed once and serving all users:
- The Oyster Surface frontend — a static React app served from a CDN
- Auth, billing, user management
- A tenant router that directs requests to the right runtime
- A runtime version manager that controls which image version each tenant runs (for canary rollouts and gradual upgrades)
- A shared database for user accounts, billing, and tenant metadata
- It knows nothing about any user's projects, artifacts, or knowledge graph

**Oyster Runtime** is the per-tenant environment where all work happens:
- OpenCode with full filesystem access to all artifacts
- The knowledge graph (Postgres)
- All generated artifact files and their runtimes
- Conversation history and AI memory

The runtime is a **versioned container image** controlled by the platform team. Upgrading Oyster means building a new image and rolling tenants onto it — blue-green, canary, or instant. The user doesn't SSH into anything. From their perspective, Oyster just gets better.

This model preserves tenant-scoped agent visibility: OpenCode inside a runtime sees everything for that tenant, nothing for other tenants. The isolation boundary is between tenants, which is exactly where it should be.

#### Model C: Central AI + Distributed Data (Future Option)

An alternative to per-tenant runtimes: centralise the AI compute and give workers on-demand access to tenant data.

```
┌── Control Plane ─────────────────────┐
│  Oyster Surface (CDN)                │
│  Auth / Billing                      │
│  AI Compute Pool                     │
│  ├── OpenCode worker (User A)        │
│  ├── OpenCode worker (User B)        │
│  └── OpenCode worker (idle)          │
└───────────┬──────────────────────────┘
            │
  ┌─────────▼──────────┐
  │  Data Layer         │
  │  (per-tenant)       │
  │                     │
  │  User A: PG + files │
  │  User B: PG + files │
  └─────────────────────┘
```

When a user sends a message, the control plane grabs an available worker from the pool, connects it to that user's data layer, the worker does its job, and releases back to the pool.

**Advantages:** No idle AI compute per tenant. 100 users might only need 10 workers. Upgrading OpenCode is redeploying the worker pool — instant, every user gets it.

**Disadvantages:** The worker needs access to user data over a network (latency). More complex data layer abstraction — OpenCode currently assumes local filesystem access.

**When this becomes relevant:** When the cost of idle per-tenant runtimes becomes significant, or when AI compute is the dominant cost and pooling it saves money.

**Key constraint:** OpenCode currently assumes local filesystem access. Moving to this model requires abstracting file operations behind an API — reading from object storage, writing via API. This is real engineering work, not a config change.

#### What to choose when

| Situation | Model |
|-----------|-------|
| PoC, single user, validating the product | Model A (single machine) |
| First paying users, managed service | Model B (control plane + per-tenant runtime) |
| Scale (hundreds of users, cost optimisation) | Model C (central AI + distributed data) |
| Self-hosted power users | Model A (they run it locally) |

The artifact contract is the same in all models. The manifest schema, folder conventions, and agent instructions don't change. The differences are purely in how the runtime is provisioned, how OpenCode accesses files, and how artifacts are served.

### The Footgun to Avoid

Do not treat "single HTML file" as the product model. It is one runtime class (`static`) — the simplest one. The product model is the artifact contract: folder, manifest, declared runtime, declared storage, declared capabilities. When persistence, auth, file uploads, collaboration, or proper data models are needed, they are expressed in the manifest's `storage` and `capabilities` fields, and handled by the appropriate runtime class.

### Key Decision That Matters Now

Do not couple the frontend to the runtime's filesystem. The Oyster Surface communicates with OpenCode and the artifact registry via HTTP/SSE APIs. As long as that boundary stays clean, splitting into control plane and data plane later is a clean cut, not a rewrite. The current server architecture already has this boundary — the frontend fetches from `/api/artifacts` and streams from `/api/chat/events`.

---

## Session Model

**Mental model:** Google, not ChatGPT. Home is always a clean slate. Sessions are bookmarkable URLs.

### PoC: Fresh Home + Session URLs

Navigating to `/` always creates a new OpenCode session — no old messages, no history loading. The hero chatbar is an honest invitation to start.

When the user sends their first message, the URL updates to `/session/:id`. Refreshing that URL reloads the conversation. Browser back to `/` starts fresh.

One `opencode serve` process per runtime. Messages are sequential. OpenCode persists sessions to SQLite natively. No concurrency.

### Production: Session Browser + Cross-Session Intelligence

Each conversation has a unique URL. A session browser UI lets users search and revisit past sessions. Oyster (the AI) can reference past sessions when relevant — pulling context across conversations to build continuity.

`.opencode/agents/oyster.md` and the persistent workspace provide continuity between sessions at the engine level.

Concurrency: one active session per user runtime. Messages are queued. Parallel sessions are out of scope until a locking strategy exists.

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

**Note:** OpenCode has native MCP support. Connectors can be implemented as MCP servers, managed via the REST API (`GET /mcp`, `POST /mcp/{name}/connect`). The Oyster server itself exposes an MCP endpoint (`localhost:4200/mcp/`) that any agent — not just OpenCode — can use to manage the desktop surface. This is how Claude Code, Cursor, or any other agent with MCP support can create artifacts and navigate spaces without touching the filesystem directly.

---

## Provisioning (Production Path)

### Per-user runtime model

Each user gets an isolated Oyster Runtime with:
- OpenCode (`opencode serve`)
- Local Postgres (app data only)
- Persistent volume (filesystem, artifacts, OpenCode sessions/config, local DB)
- Connection to central Supabase (knowledge graph)

### Signup flow
1. User signs up → Supabase Auth creates account
2. Control plane provisions runtime from versioned base image
3. Local Postgres initialises (empty, for app data)
4. Runtime gets persistent volume
5. User connects via HTTP/SSE through tenant router

### Schema migrations
- Central Supabase schema: one migration, all users updated instantly
- Local app schemas: owned by OpenCode, no fleet-wide migrations needed
- Runtime image updates: build new version, roll tenants gradually (blue-green or canary)
- This split is why the central/local separation exists

### Upgrade model
- **Control plane (UI, auth, billing):** Standard SaaS deployment. Deploy to CDN + backend services. All users get updates immediately.
- **Oyster Runtime (OpenCode, artifact serving):** Versioned container image. Build new image, roll tenants to it. Their data persists on volumes; only the engine changes.
- **Artifact runtimes:** User-controlled. The AI creates and manages them within the tenant's runtime.

### PoC constraints to respect for production readiness
- Use `$DATABASE_URL` and `$OYSTER_WORKSPACE` env vars, not hardcoded paths
- Keep `.opencode/agents/oyster.md`, schema migrations, and config in one repo (future Docker image source)
- No user identity in the knowledge graph schema for PoC, but the column is defined for production
- Keep the frontend → server boundary as HTTP/SSE APIs (not filesystem coupling)

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
- [x] Space-based navigation with persistent space pills above chatbar
- [x] Hero tagline ("Tools are dead. Welcome to the shell.") with rotating nudges on blur
- [x] Ultra Hardcore terminal gate (first-time confirmation modal with localStorage)
- [x] Multi-space registry with `space` field filtering artifacts per workspace
- [x] Markdown rendering for doc artifacts (marked library)
- [x] Fresh session model — home always starts new session, session URLs bookmarkable
- [x] Deck artifacts open fullscreen with draggable light frosted-glass toolbar
- [x] Self-healing artifact cleanup + name override system for special characters
- [x] "The World's Your Oyster" showcase deck with FaultyTerminal WebGL background
- [x] Chat API layer (SSE streaming to OpenCode, session management)
- [x] Wire chat bar input to OpenCode session
- [~] Supabase schema — superseded: using SQLite (`userland/oyster.db`) for PoC artifact registry
- [~] Supabase realtime subscriptions — superseded: SQLite + polling via `/api/artifacts`
- [x] Real artifact generation + appearance on surface (auto-detected from userland/ via file watcher)
- [x] Artifact manifest schema (folder + manifest.json per artifact)
- [x] MCP server at `localhost:4200/mcp/` — agent tool surface for surface management (Phase 1: discover + register; Phase 2: create, read, update)
- [x] AI-generated artifact icons (GPT-4o-mini + fal.ai Flux Schnell)
- [x] Knowledge graph memory layer (Graphiti, localhost:8000)
- [x] Drag-to-reorder desktop icons with localStorage persistence
- [x] Fullscreen preference persistence per artifact

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
- Session browser/search UI (browse and revisit past conversations)
- Cross-session AI references (Oyster recalls context from past sessions)
- Bar as universal input (search + navigation)
- Seeded starter artifacts on first use (sample content for personal/kps spaces added)
- Advanced graph visualisation
- Tier 2 runtime (`vite` runtime class for full project artifacts)
- Tier 3 runtime (Docker / Firecracker containerised artifacts)
- Control plane / data plane split for multi-tenant deployment

---

## Open Questions

1. ~~What's the app serving URL pattern for generated apps?~~ Resolved: `/artifacts/<id>/` with entrypoint from manifest.
2. ~~Deployment: single VPS vs split?~~ Resolved: Single machine for PoC (Model A). Control plane + runtime split for production (Model B). See deployment models section.
3. How to handle touch device drag (pointer events conflict with touch scrolling)?
4. Should the artifact manifest include a `version` field for tracking iterations?
5. When the agent updates an artifact's files, should it also bump `updated_at` in the manifest, or should the server detect changes and update metadata?


