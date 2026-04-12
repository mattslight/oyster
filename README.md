# Oyster

A modern OS for knowledge work powered by MCP — connect your projects, control everything from a prompt. Bring your own LLM. Install as easy as `npm install oyster-os`

Open the right thing, switch context quickly, and organise work from one chat bar.  
Oyster is local, AI-first, visual, and built for people juggling multiple projects, tools, and sessions.

![Oyster desktop](docs/screenshots/desktop.png)

## Why Oyster

Most work is scattered across folders, repos, docs, tabs, and chat threads.

Oyster puts that work on one surface and lets you control it with simple commands.

- **Open things fast**  
  Type `/o competitor analysis` and open the right artefact without digging through folders.

- **Switch context quickly**  
  Jump between spaces with `/s blunderfixer` or `#bf`.

- **Keep work visible**  
  Docs, diagrams, apps, decks, and spreadsheets live together on a visual desktop.

- **Let the agent act on the surface**  
  Oyster can open artefacts, switch spaces, and organise the workspace through MCP tools.

- **Bring your own AI**  
  Oyster speaks MCP — the open standard that lets AI tools talk to each other. Connect the AI you already use and it can control your workspace directly.

## Quick start

### Install and run

```bash
npm install -g oyster-os
oyster
```

That's it. On first run, Oyster connects you to an AI provider (opens your browser to sign in). Then your workspace opens at **http://localhost:4200**.

### Connect your AI

Oyster is an MCP server. Any MCP-compatible tool can control your workspace.

**Claude Code:**

```bash
claude mcp add --transport http oyster http://localhost:4200/mcp/
```

**Cursor / VS Code / other MCP clients** — add to your MCP config:

```json
{
  "oyster": {
    "type": "http",
    "url": "http://localhost:4200/mcp/"
  }
}
```

Once connected, your AI can list spaces, open artefacts, create documents, onboard projects, and manage the surface directly.

### Onboard a project

From the Oyster chat bar:

```
onboard my project at ~/Dev/my-project
```

Or from Claude Code / any connected AI:

```
> onboard_space(name: "My Project", repo_path: "/path/to/my-project")
```

Oyster scans the folder for documents, apps, and diagrams and adds them to the surface automatically.

## What works today

- Prompt-driven navigation
- Space switching
- Artefact desktop with icons
- Local repo onboarding
- MCP server with 12 tools (works with Claude Code, Cursor, any MCP client)
- Instant UI updates via SSE
- Slash commands (`/s`, `/o`, `#`)

## Commands

| Command | What it does |
|---|---|
| `/s <space>` | Switch to a space |
| `/o <query>` | Open an artefact by name |
| `#<space>` | Quick space switch |
| `#<number>` | Jump to a numbered space |
| normal chat | Ask Oyster to navigate or organise work |

Examples:

```
/s blunderfixer
/o pricing deck
#home
#2
```

## The full loop

Here's what it looks like end to end:

```bash
# 1. Install Oyster
npm install -g oyster-os

# 2. Start it
oyster
# → browser opens to http://localhost:4200

# 3. Connect Claude Code (or any MCP client)
claude mcp add --transport http oyster http://localhost:4200/mcp/

# 4. From Claude Code, onboard a project
> onboard_space(name: "My App", repo_path: "~/Dev/my-app")
# → Oyster scans for docs, apps, diagrams

# 5. From the Oyster chat bar
show me the architecture diagram
# → artifact opens in the viewer

# 6. Switch spaces
#1
# → instant switch to your first project
```

## Who it is for

Oyster is for people working across more than one project, repo, or tool at a time, especially:

- founders
- builders
- consultants
- product teams
- anyone tired of folder hunting and tab overload

## Current status

Early v1.  
Local-first. Single-user. Built for fast iteration.

**In scope now**
- prompt-driven surface control
- artefact management
- repo onboarding
- visual workspace
- MCP server

**Planned later**
- dynamic UI — interfaces that adapt to the task at hand, not static layouts
- cloud hosting
- persistent memory
- richer plugins and integrations

## Architecture

```
Browser → http://localhost:4200
              |
        Oyster Server
         - SQLite (artefacts, spaces)
         - MCP server (/mcp/)
         - SSE push (instant UI updates)
         - Static web UI
         - Chat proxy → OpenCode → LLM
```

## Contributing

Oyster is still early, but focused contributions are welcome.

Good areas to help with:

- onboarding and setup
- slash commands
- artefact search and ranking
- UI polish
- MCP connectors

If you want to contribute:

1. Open an issue first
2. Keep the scope tight
3. Send a focused PR with a clear before and after

### Development

```bash
git clone https://github.com/mattslight/oyster.git
cd oyster
cd web && npm install && cd ../server && npm install && cd ..
npm run dev
# → dev server at http://localhost:7337 (proxies to server at 4200)
```

## Roadmap

**Short term:**

- smoother onboarding
- faster artefact opening and navigation
- better repo import experience

**Longer term:**

- dynamic UI — surfaces that reshape to fit the job
- cloud and hybrid hosting
- persistent memory
- plugin ecosystem
- richer cross-space search and automation

## Licence

[AGPL-3.0](LICENSE)

Copyright (c) 2026 Matthew Slight

You can use, modify, and distribute this software freely. If you run a modified version as a network service, you must make your source code available under the same licence.
