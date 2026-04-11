# Oyster OS — Working Context

## Hypothesis

The right interface for knowledge work is a **surface that connects all your systems, accumulates context over time, and synthesises across boundaries** — so you can ask a question that spans Zoho and ProCore and last month's conversation and get one answer, not three logins.

Not just for makers and developers. For anyone whose work is distributed across more than one system and one session.

**The key test:** can the surface join dots that no single tool, dashboard, or LLM session could? A dashboard can't — it's a pre-defined view. ChatGPT can't — it has no live access and forgets. A Zoho report can't — ProCore isn't in scope. Oyster can, because it connects all systems via MCP, holds the relationships between them in a knowledge graph, and accumulates context across every session.

## Architecture

Three systems, three responsibilities:

| System | Port | Responsibility |
|---|---|---|
| Oyster Server | 4200 | Artifact/space registry (SQLite), MCP tool surface, chat proxy |
| OpenCode | 4096 | AI engine, code execution, filesystem access |
| Graphiti | 8000 | Knowledge graph, persistent memory, cross-session context (Docker/FalkorDB) |

**SQLite** (`userland/oyster.db`) holds surface state: artifacts and spaces. Fast, local, no infrastructure.

**Graphiti** is the memory layer. Everything is nodes and edges — no separate tables. Episodes are ingested, entities and facts extracted by LLM automatically. The agent calls `search_nodes`/`search_facts` before answering, and `add_episode` to remember things. Configured in `opencode.json`, mandatory rules in `.opencode/agents/oyster.md`.

**OpenCode** has MCP access to both Oyster (surface) and Graphiti (memory). The UI talks only to Oyster Server.

## Mental Models

**Spaces** — organisational nodes, navigated via `parent_id` hierarchy in SQLite (nav only). Semantic relationships between spaces (client_of, depends_on, shares_pattern) live as edges in the Graphiti graph — not SQL columns. "Tell me about all my client projects" is a graph traversal, not a container space query.

**Artifacts** — typed outputs on the surface (app, notes, diagram, deck, wireframe, table, map). Registered in SQLite, files in `userland/`. `source_origin` tracks provenance: `manual` | `discovered` | `ai_generated`.

**Groups/folders** — display clustering only (`group_name` on artifacts). Not structural.

## Key Files

- `server/src/index.ts` — HTTP server, all API routes
- `server/src/mcp-server.ts` — MCP tool surface for agents
- `server/src/artifact-store.ts` / `artifact-service.ts` — artifact CRUD
- `server/src/space-store.ts` / `space-service.ts` — space CRUD + repo scanner
- `server/src/db.ts` — SQLite schema and migrations
- `.opencode/agents/oyster.md` — agent personality, Graphiti rules, conventions
- `opencode.json` — MCP server config (Oyster + Graphiti endpoints)
- `web/src/App.tsx` — root, spaces/artifacts state, wizard triggers
- `web/src/components/Desktop.tsx` — surface grid, topbar, sort/filter/view
- `web/src/components/ChatBar.tsx` — chat input, space pills, messages panel

## Conventions

- Prefer editing existing files over creating new ones
- MCP tools for surface management; direct filesystem for artifact content
- Never write to `userland/oyster.db` directly from agent — use MCP tools
- `source_origin: 'ai_generated'` on all agent-created artifacts
- SQLite migrations are additive `ALTER TABLE ... ADD COLUMN` with try/catch (idempotent)
- Space `parent_id` is nav only — don't encode semantics there, use the graph

---

## Behavioral Guidelines

Bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

- State your assumptions explicitly before implementing. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

- Minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- Ask: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

- Touch only what you must. Clean up only your own mess.
- Don't improve adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- Remove imports/variables/functions that *your* changes made unused.
- Don't remove pre-existing dead code unless asked.
- Every changed line should trace directly to the request.

### 4. Goal-Driven Execution

- Transform tasks into verifiable goals before coding:
  - "Fix the bug" → "Write a test that reproduces it, then make it pass"
  - "Add validation" → "Write tests for invalid inputs, then make them pass"
- For multi-step tasks, state a brief plan with verify steps before starting:
  1. [Step] → verify: [check]
  2. [Step] → verify: [check]
