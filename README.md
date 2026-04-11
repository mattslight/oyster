# Oyster OS

A modern workspace that connects all your systems, accumulates context over time, and lets you control everything from a single prompt.

Not another dashboard. Not another chat thread. A surface that joins dots across projects, tools, and sessions — so you can ask one question and get one answer, not three logins.

## What it does

**Prompt-driven navigation** — type "show me the competitor analysis" and it opens. Type "switch to blunderfixer" and it navigates. The chat bar is your command line for knowledge work.

**Artifact surface** — docs, diagrams, apps, presentations, and spreadsheets live as icons on a visual desktop. Organised by spaces (workspaces), searchable, and launchable.

**Instant commands** — `#bf` switches to blunderfixer. `#1` jumps to your first space. `/o competitor` opens the right artifact with token-scored search. No waiting for AI.

**AI that controls the OS** — the agent can create artifacts, open files, switch spaces, and manage your surface via MCP tools. You describe what you need, it builds and organises.

**Connect any project** — onboard a local repo and Oyster scans for apps, docs, and diagrams automatically. Your existing work becomes part of the surface.

## Who it's for

Anyone whose work is distributed across more than one system and one session. Builders, founders, consultants, project managers — if you context-switch between projects and tools daily, Oyster is your home screen.

## Status

Early v1 — local-first, single user. The surface works, prompt-driven navigation works, artifact management works. Cloud hosting and persistent memory are planned.

## Quick start

```bash
# Prerequisites: Node.js 22+
git clone https://github.com/mattslight/oyster-os.git
cd oyster-os
npm install && cd web && npm install && cd ../server && npm install && cd ..
npm run dev
# Opens at http://localhost:7337
```

You'll need API keys in a `.env` file at the project root:

```
ANTHROPIC_API_KEY=your-key
FAL_KEY=your-key          # optional, for AI-generated icons
```

## Commands

| Command | What it does |
|---|---|
| `/s <prefix>` | Switch space by name |
| `/o <search>` | Open artifact by name (token-scored) |
| `#<space>` | Quick space switch (`#bf`, `#home`, `#all`) |
| `#<number>` | Jump to nth space (`#1`, `#2`, `#0` = all) |
| Just type... | Chat bar auto-focuses. Ask anything. |

## Architecture

```
Oyster Server (4200)  ─── SQLite (artifacts, spaces)
     │                         
     ├── MCP tools (agent surface control)
     ├── SSE push (instant UI updates)  
     └── Chat proxy ──► OpenCode (4096) ──► LLM
     
Web UI (7337 dev)     ─── React + Vite
```

## License

All rights reserved. License TBD.

Copyright (c) 2026 Matthew Slight
