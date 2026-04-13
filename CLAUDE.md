# Oyster — Working Context

## What Oyster Is

A prompt-controlled workspace OS. Users install it with `npm install -g oyster-os`, run `oyster`, and get a visual surface at `http://localhost:4444` where they organise files, projects, and artefacts — controlled from a chat bar and slash commands.

## Architecture

One server does everything:

```
Browser → http://localhost:4444
              |
        Oyster Server
         - SQLite (artefacts, spaces)
         - MCP server at /mcp/ (externally connectable)
         - SSE push (instant UI updates)
         - Static web UI (server/dist/public/)
         - Chat proxy → OpenCode (spawned internally) → LLM
```

**Oyster Server** (port 4200) — HTTP API, artifact/space registry (SQLite), MCP tool surface, static web serving, chat proxy to OpenCode. This is the only user-facing port.

**OpenCode** — AI engine, spawned as a subprocess by the server. Not user-facing. Configured via `.opencode/agents/oyster.md` and `.opencode/config.toml`.

**SQLite** (`~/.oyster/userland/oyster.db`) — artefact and space registry. Fast, local, no infrastructure.

**No persistent memory in v1.** Cross-session memory (Graphiti / knowledge graph) is deferred to v2. The agent is stateless between sessions.

## Mental Models

**Spaces** — organisational nodes. Each space has an ID, display name, optional repo path, and colour. Navigated via pills at the bottom of the chat bar, or via `#space` / `/s space` commands.

**Artefacts** — typed outputs on the surface (app, notes, diagram, deck, wireframe, table, map). Registered in SQLite, files in `~/.oyster/userland/`. `source_origin` tracks provenance: `manual` | `discovered` | `ai_generated`.

**MCP** — the server exposes 15 tools at `/mcp/`. Any MCP client (Claude Code, Cursor, etc.) can connect and control the surface.

## Key Files

- `bin/oyster.mjs` — CLI entry point (auth check, browser open)
- `server/src/index.ts` — HTTP server, all API routes, SSE, static serving, MCP
- `server/src/mcp-server.ts` — MCP tool definitions
- `server/src/artifact-store.ts` / `artifact-service.ts` — artifact CRUD
- `server/src/space-store.ts` / `space-service.ts` — space CRUD + repo scanner
- `server/src/db.ts` — SQLite schema and migrations
- `.opencode/agents/oyster.md` — agent personality, conventions
- `opencode.json` — OpenCode config (model, MCP endpoints)
- `web/src/App.tsx` — root component, state, SSE subscription
- `web/src/components/Desktop.tsx` — surface grid, topbar, sort/filter/view
- `web/src/components/ChatBar.tsx` — chat input, slash commands, space pills

## How to build and run

```bash
# Development
cd web && npm install && cd ../server && npm install && cd ..
npm run dev              # Vite dev server at 7337, proxies to server at 4200

# Production build
npm run build            # Builds web + server + copies web into server/dist/public/

# Run from build
node server/dist/server/src/index.js

# Published package
npm install -g oyster-os
oyster                   # Starts server, opens browser to localhost:4444
```

## Conventions

- Prefer editing existing files over creating new ones
- MCP tools for surface management; direct filesystem for artifact content
- Never write to SQLite directly from agent — use MCP tools
- `source_origin: 'ai_generated'` on all agent-created artifacts
- SQLite migrations are additive `ALTER TABLE ... ADD COLUMN` with try/catch (idempotent)
- Userland data lives at `~/.oyster/userland/` (not in the package directory)
- Always use feature branches, never commit to main directly

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
