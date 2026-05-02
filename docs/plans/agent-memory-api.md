# Agent-facing memory API

> **Status:** canonical architectural decision. Cites [`docs/requirements/oyster-cloud.md`](../requirements/oyster-cloud.md) — does not redefine those outcomes. If a requirement and this doc conflict, the requirement wins.

## Decision

The agent-facing API for memory is **MCP, on the local Oyster server** — today and going forward. Cloud doesn't change that. What changes when Pro lands is what's wired behind the MCP tool, not what the agents call.

```
Agent (Claude Code / Cursor / Codex / …)
   │
   │  MCP — `remember`, `recall`, `forget`, `list_memories`
   ▼
Local Oyster server (always running on the user's machine)
   │
   │  free / today: SqliteFtsMemoryProvider → <userland>/db/memory.db
   │  Pro (0.8.0+):  CloudMemoryProvider → Cloudflare D1 + Vectorize
   ▼
Cloud (Pro only)
```

`<userland>` resolves to `~/Oyster/` for the installed package, `./userland/` in dev, or whatever `OYSTER_USERLAND` is set to.

## Requirements served

- **R4 (memory crosses agents)** — delivered structurally by every connected agent talking to the same MCP. A per-agent integration or per-agent skill would need re-implementing across the matrix of agents.
- **R2 (conversational recall)** — needs FTS + vector queries that aren't realistic over a flat file scan. The MCP boundary lets us put the index where it has to go without leaking that detail to agents.
- **R1 (empty-machine continuity)** — Pro turns on without agent reconfiguration. Magic-link sign-in flips the local provider from local-SQLite to cloud-backed; agents see no difference.

## What 0.8.0 actually changes

Behind the same MCP tool surface:

1. Magic-link sign-in stores a token in `~/Oyster/config/`.
2. The local server's `MemoryProvider` becomes a write-through-cache: writes go to cloud + local; reads check local first then cloud; offline writes queue and replay.
3. Cross-device propagation: another signed-in machine's local server pulls cloud writes and replays into its local DB. Its agents see the same memory store via MCP.

Same MCP tools, same agent config, same `localhost:4444/mcp/`.

## What skills are, and why they're complementary

Skills are prompt-layer instructions that tell an agent *when* and *how* to use a tool. They sit on top of an actual transport (MCP, Bash, Read/Write). A skill called `oyster-memory` might tell Claude *"when the user shares a durable preference, call `mcp__oyster__remember`"* — useful, and we may publish one alongside the package. But the I/O still goes over MCP. Skills are not a transport.

## What about file-based memory (the markdown-files-synced-via-git pattern)

Real merits — git-syncable, vim-editable, no infrastructure — but as the *agent-facing API* it loses on:

- **R2** — no realistic semantic / verbatim recall over a file scan at scale.
- **R4** — concurrent writers from agents that don't coordinate is fragile.
- **Cloud mirroring** — file-tree-sync (git, rsync) is materially more work than swapping a `MemoryProvider` implementation.
- **Soft-delete semantics** — `forget` via filesystem is `rm`; the existing supersede-chain is gone.

It can live as an alternative `MemoryProvider` implementation *behind* the MCP surface for users who want that substrate (e.g. a `GitMarkdownMemoryProvider`). The file convention is a storage choice, not the agent contract.

## Non-MCP consumers

- **The Oyster web UI** hits the local HTTP API (`/api/memories`) on top of the same provider.
- **CLI scripts / integrations / future Slack bot / etc.** can use MCP, the local HTTP API, or (eventually) a cloud HTTP API. None replace MCP as the agent path.

## How to update this doc

Replace, don't append, when the decision changes. If we ever decide to expose memory via something other than MCP, that's a fork in this doc, not a layer added on top — and a check against R1–R7 to make sure the requirements still hold under the new shape.
