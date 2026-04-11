# Oyster

A modern OS for knowledge work powered by LLM — connect your projects, control everything from a prompt / MCP

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

## What works today

- Prompt-driven navigation
- Space switching
- Artefact desktop with icons
- Local repo onboarding
- MCP-powered agent actions (works with Claude Code, Cursor, any MCP client)
- Instant UI updates via SSE

## Example

Things you can type into Oyster:

```text
show me the competitor analysis
switch to blunderfixer
/o competitor analysis
/s home
#bf
#1
```

## Quick start

### Requirements

Node.js 22+

### Install

```bash
git clone https://github.com/mattslight/oyster.git
cd oyster
npm install
npm run dev
```

Open:

**http://localhost:7337** 😎

Create a `.env` file at the project root with your preferred AI provider key:

```
ANTHROPIC_API_KEY=your-key    # or OPENAI_API_KEY, etc.
FAL_KEY=your-key              # optional — AI-generated icons
```

Oyster uses OpenCode under the hood, which supports Anthropic, OpenAI, Gemini, Groq, and Ollama. Bring whichever AI you prefer.

## Core commands

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

**Planned later**
- dynamic UI — interfaces that adapt to the task at hand, not static layouts
- cloud hosting
- persistent memory
- richer plugins and integrations

## Architecture

```
Web UI (React + Vite)
        |
        v
Oyster Server
  - SQLite
  - MCP tools
  - SSE updates
  - chat proxy
        |
        v
OpenCode / LLM
```

## Contributing

Oyster is still early, but focused contributions are welcome.

Good areas to help with:

- onboarding and setup
- slash commands
- artefact search and ranking
- UI polish
- packaging and distribution

If you want to contribute:

1. Open an issue first
2. Keep the scope tight
3. Send a focused PR with a clear before and after

## Roadmap

**Short term priorities:**

- smoother onboarding
- stronger packaging and distribution
- faster artefact opening and navigation
- better repo import experience

**Longer term:**

- dynamic UI — surfaces that reshape to fit the job, not one-size-fits-all layouts
- cloud and hybrid hosting
- persistent memory
- plugin ecosystem
- richer cross-space search and automation

## Licence

[AGPL-3.0](LICENSE)

Copyright (c) 2026 Matthew Slight

You can use, modify, and distribute this software freely. If you run a modified version as a network service, you must make your source code available under the same licence.
