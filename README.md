<p align="center"><img src="docs/hero-banner.png" alt="Oyster — From prompt to workspace" /></p>

[![Release](https://img.shields.io/github/v/release/mattslight/oyster?color=7c6bff)](https://github.com/mattslight/oyster/releases)
[![npm](https://img.shields.io/npm/v/oyster-os?color=7c6bff)](https://www.npmjs.com/package/oyster-os)
[![Downloads](https://img.shields.io/npm/dm/oyster-os?color=7c6bff)](https://www.npmjs.com/package/oyster-os)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-7c6bff)]()
[![License](https://img.shields.io/badge/License-AGPL--3.0-7c6bff)](LICENSE)

---

**🦪 The OS that understands your projects, remembers your work, and acts from one prompt. Powered by MCP — bring any AI.**

```bash
# 1. Install
npm install -g oyster-os

# 2. Configure & Start
oyster

# 3. Open your browser to http://localhost:4444
```

## Why Oyster

Your work is scattered across folders, repos, docs, tabs, and chat threads. Oyster puts it all on one visual surface and lets you control it from a chat bar.

- **Open things fast** — type `/o competitor analysis` and it opens, no folder hunting
- **Switch context instantly** — `#blunderfixer` or `#1` to jump between projects
- **See everything at once** — docs, diagrams, apps, decks, and spreadsheets on one desktop
- **Any AI can control it** — Oyster speaks MCP, the open standard for AI tools. Connect Claude Code, Cursor, or any MCP client and your AI can manage the surface directly

![Oyster desktop](docs/screenshots/desktop.png)

## Quick Start

```bash
npm install -g oyster-os
oyster
```

That's it. On first run, Oyster connects you to an AI provider (opens your browser to sign in). Then your workspace opens at **http://localhost:4444**.

Or try without installing:

```bash
npx oyster-os
```

## Connect Your AI

Oyster is an MCP server. Any MCP-compatible tool can connect and control your workspace.

**Claude Code:**

```bash
claude mcp add --scope user --transport http oyster http://localhost:4444/mcp/
```

**Cursor / VS Code / other MCP clients** — add to your MCP config:

```json
{
  "oyster": {
    "type": "http",
    "url": "http://localhost:4444/mcp/"
  }
}
```

Once connected, your AI can list spaces, open artefacts, create documents, onboard projects, and manage the surface directly.

## Onboard a Project

From the Oyster chat bar:

```
onboard my project at ~/Dev/my-project
```

Oyster scans the folder for documents, apps, and diagrams and adds them to the surface automatically.

## Commands

| Command | What it does |
|---|---|
| `/s <space>` | Switch to a space — `/s blunderfixer` opens that space |
| `/o <query>` | Open an artefact by name — `/o pricing deck` finds and opens it |
| `#<space>` | Quick space switch — `#home` goes home, `#bf` matches blunderfixer |
| `#<number>` | Jump to a numbered space — `#1` switches to first space |
| `#.` | Go to the home screen |
| normal chat | Ask Oyster anything — navigate, organise, or create work |

## Architecture

```
Browser → http://localhost:4444
              |
        Oyster Server
         - SQLite (artefacts, spaces)
         - MCP server (/mcp/)
         - SSE push (instant UI updates)
         - Static web UI
         - Chat proxy → OpenCode → LLM
```

## Status

Early v1. Local-first. Single-user. Built for fast iteration.

**Now:** MCP powered workspace, bring your own AI, prompt-driven navigation, space switching, artefact desktop, repo onboarding, persistent memory (remember/recall), 19 MCP tools, slash commands, instant UI updates via SSE.

**Next:** smoother onboarding, faster artefact navigation, better repo import.

**Vision:** plugins, dynamic UI that reshapes to fit the task, build & share apps.

See every shipped change in the [changelog](https://oyster.to/changelog).

## Contributing

Oyster is early, but focused contributions are welcome.

1. Open an issue first
2. Keep the scope tight
3. Send a focused PR with a clear before and after

### Development

```bash
git clone https://github.com/mattslight/oyster.git
cd oyster
cd web && npm install && cd ../server && npm install && cd ..
npm run dev
# → dev server at http://localhost:7337 (proxies to server at 3333)
```

## Licence

[AGPL-3.0](LICENSE)

Copyright (c) 2026 Matthew Slight

You can use, modify, and distribute this software freely. If you run a modified version as a network service, you must make your source code available under the same licence.


<!-- Fix #193 -->
