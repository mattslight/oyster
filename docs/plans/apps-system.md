# Oyster Plugin & App System — Design Notes

> **Status (2026-04):** Exploratory design. Tier 1 install flow (manual drop-in) works today via the existing artifact detector. Tiers 2 and 3 are future work. The `builtins/` apps (zombie-horde, quick-start, etc.) are effectively first-party plugins with `builtin: true`. Third-party plugins live in their own repos — **the Oyster monorepo does not contain example plugins.**

## Core Insight

**Apps and plugins are the same concern.** The existing `builtins/<name>/manifest.json` shape already *is* a plugin manifest. The only difference between a shipped-in-package app (zombie-horde) and a user-installed plugin is provenance — `builtin: true` vs `false` — and the folder they live in. One loader, one manifest schema.

```json
{
  "id": "pomodoro",
  "name": "Pomodoro",
  "type": "app",
  "runtime": "static",
  "entrypoint": "src/index.html",
  "ports": [],
  "storage": "none",
  "capabilities": [],
  "builtin": false
}
```

The `runtime` field is the forward-looking lever — it lets new plugin kinds land without re-architecting the loader.

## Runtime Taxonomy

| `runtime` | What it loads | Status |
|---|---|---|
| `static` | folder with `entrypoint` HTML, served as an iframe artifact | ✅ supported (builtin: zombie-horde; 3p: pomodoro) |
| `bundle` | `main.js` bundled with esbuild, runs in sandboxed iframe, talks to host via `postMessage` | next |
| `mcp` | server-side Node module that registers tools at `/mcp/` alongside the built-in 19 | after `bundle` |
| `panel` | React component mounted into `Desktop.tsx` shell (Obsidian's native model) | eventually |

Pomodoro (`mattslight/oyster-sample-plugin`, separate repo) uses `runtime: "static"` and is the reference demonstration for Tier 1 install.

## What We Learned From Obsidian

Obsidian's sample plugin (`obsidianmd/obsidian-sample-plugin`) and its install model are the clearest prior art. Key patterns worth adopting:

### Plugin class + lifecycle hooks
Plugins extend a `Plugin` base class and implement `onload()` / `onunload()`. The host provides auto-cleanup registration helpers — `addCommand`, `addRibbonIcon`, `addStatusBarItem`, `addSettingTab`, `registerEvent`, `registerDomEvent`, `registerInterval`. Anything registered through these is automatically torn down on unload. **Plugins never manage their own listener lifecycles.** This is the single most important architectural lever — it prevents leak hell as the plugin ecosystem grows.

For Oyster's future `bundle` / `panel` runtimes, mirror this: `api.registerCommand(...)`, `api.registerArtifactType(...)`, `api.registerMCPTool(...)`, `api.registerSurfacePanel(...)`.

### Host as external at build time
Obsidian's `esbuild.config.mjs` marks `obsidian`, `electron`, `@codemirror/*` as externals. Plugins bundle their own deps but never the host. Oyster's equivalent: ship `@oyster/plugin-sdk` (types + runtime shims), mark it external at plugin build time.

### `loadData()` / `saveData()` for settings
Flat JSON persistence the host owns. Plugin never touches disk directly. For Oyster, plugins get a scoped SQLite namespace — same "host owns storage" rule.

### Stable IDs post-release
Command IDs and plugin `id` must never change once published. They become keys in user config. Non-negotiable for Oyster's slash commands and artifact types.

### Compatibility matrix via `versions.json`
Maps plugin versions → min host versions so old hosts can still pull a compatible plugin build. Matters more for Oyster than it first appears: MCP tool schemas will evolve. Need a `minOysterVersion` in manifest *before* Tier 2 ships.

### No runtime sandbox; trust via community review
Plugins run with full host access. Safety is norms-based (AGENTS.md): "local/offline default, no RCE, no hidden telemetry, explicit opt-in for network."

**Oyster should diverge here.** Oyster's natural security boundary is MCP. Force plugins to do workspace mutations through the same MCP surface external AIs already use — then you get an audit log, permission scope, and no raw SQLite access, for free. The `capabilities` manifest field becomes the explicit opt-in: `["mcp:read", "mcp:write", "network", "storage"]`.

## Three-Tier Install Flow (Obsidian's Model)

All three tiers are layered on top of GitHub Releases. The technical primitive is always "download release assets into a folder."

### Tier 1 — Manual drop-in (no infrastructure)
User creates `<vault>/.obsidian/plugins/<id>/` with `manifest.json` + `main.js` + optional `styles.css`. Enables in settings.

**Oyster equivalent today:** drop a folder into `~/.oyster/userland/<id>/`. The existing artifact detector (`server/src/artifact-detector.ts`) picks up the manifest and registers the artifact. Works without any new code.

```bash
git clone https://github.com/mattslight/oyster-sample-plugin ~/.oyster/userland/pomodoro
# restart oyster
```

**Small improvement needed:** scan a dedicated `~/.oyster/plugins/` directory so installed plugins don't mix with user-created artifacts. Tiny patch to the bootstrap loop.

### Tier 2 — Paste a GitHub URL (BRAT-style)
Obsidian: user installs BRAT plugin, pastes `<owner>/<repo>`, BRAT fetches the latest GitHub Release (which must have `manifest.json` + `main.js` as binary attachments), drops them into `.obsidian/plugins/<id>/`, auto-updates on new releases.

**Oyster equivalent:**
```bash
oyster install mattslight/oyster-sample-plugin
oyster update pomodoro
oyster uninstall pomodoro
```
Implementation: ~50 lines. `gh api` or raw HTTPS → fetch release assets → validate `manifest.json` → write to `~/.oyster/plugins/<id>/` → signal the server to re-scan. Plus a matching slash command in chat (`/install <repo>`).

### Tier 3 — Curated community directory
Obsidian's pattern: author submits a PR to `obsidianmd/obsidian-releases` adding one entry to `community-plugins.json`. The JSON shape (shown here with an Oyster-style example, since we're documenting what Oyster's equivalent will look like):
```json
{ "id": "pomodoro", "name": "Pomodoro", "author": "mattslight",
  "description": "…", "repo": "mattslight/oyster-sample-app" }
```
Obsidian's in-app UI reads that JSON, fetches each plugin's manifest + release assets from GitHub, renders browse/search/install.

**Oyster equivalent:** an `oyster-community-apps` repo with the same JSON shape, surfaced in the Oyster UI as a browsable gallery. Not needed until there are apps worth browsing.

### Launch sequencing
- **Tier 1** → ship now. Pomodoro proves it. No code changes required beyond adding `~/.oyster/plugins/` to the scan paths.
- **Tier 2** → ship when there's a second third-party plugin to validate against. `oyster install` CLI + `/install` slash command.
- **Tier 3** → ship when the community is real. Until then it's over-engineering.

## First Use Case: Pomodoro (separate repo: `mattslight/oyster-sample-app`)

A classic 25/5/15 focus timer. Single-file `runtime: "static"` app, no dependencies, no network, no storage capability declared (uses `localStorage` which the iframe manages itself — scoped to the iframe origin, invisible to Oyster).

**Lives in its own GitHub repo** — not in the Oyster monorepo. This is intentional: the whole point of validating the install flow is that plugins live *outside* Oyster. Bundling examples inside would side-step the very thing we're testing.

Why this is the right first use case:
- Exercises the whole Tier 1 loop (manifest → detector → registered artifact → iframe render)
- Trivially safe (static HTML, no host API calls)
- Utilitarian — proves "any developer can ship a useful artifact to Oyster in 30 minutes"
- Not a game — games are too self-contained; they don't stress host integration

What pomodoro *doesn't* exercise (future test cases for richer runtimes):
- Talking to Oyster MCP tools (wait for `bundle` runtime + SDK)
- Reading artifacts / writing notes (needs MCP capabilities)
- Registering slash commands (needs `panel` or `bundle` runtime)

## Manifest Schema (extensions needed before Tier 2)

Current shape (from `builtins/zombie-horde/manifest.json`):
```json
{ "id", "name", "type", "runtime", "entrypoint",
  "ports", "storage", "capabilities", "status", "builtin",
  "created_at", "updated_at" }
```

Additions required before Tier 2 (GitHub install):
- **`version`** — semver. User-visible, used for update comparisons.
- **`minOysterVersion`** — min host version the plugin expects. Lets the loader reject incompatibly new/old plugins cleanly.
- **`author`**, **`authorUrl`**, **`description`** — surfaced in the Tier 3 gallery.
- **`repo`** — `owner/name` on GitHub. Enables `oyster update` to find new releases.

Additions worth considering at the same time:
- **`permissions`** — explicit capability opt-in (`mcp:read`, `mcp:write`, `network`, `storage`). Prompted to the user on install.
- **`fundingUrl`** — Obsidian has this; low cost, high goodwill.

## Open Questions

1. **Separate `~/.oyster/plugins/` vs single userland?** Obsidian keeps them together with other vault content (`.obsidian/plugins/`), which is fine because the folder is the plugin ID. Oyster could do the same under `~/.oyster/userland/` but a split feels cleaner for install/uninstall scripting. Lean: split.
2. **Sandbox boundary for `bundle` runtime?** Sandboxed iframe with postMessage is the safe default. The plugin gets a proxied SDK that translates calls to MCP requests. Cleaner than Obsidian's "full host access" model.
3. **Plugin updates — auto or opt-in?** Obsidian defaults to prompting. Lean: same.
4. **MCP tool plugins — in-process vs spawned?** Spawned subprocesses are safer but slower. In-process with capability gating is faster. Defer until needed.

## Planned External Repos

The Oyster monorepo stays focused on the host. Plugins and their ecosystem live in separate repos, following Obsidian's model:

| Repo | Purpose | Equivalent to |
|---|---|---|
| `mattslight/oyster-sample-app` | **Template repo** (GitHub "Use this template") that currently hosts the Pomodoro app as the reference third-party implementation. May split later into a minimal hello-world template + a dedicated pomodoro repo; for now one repo serves both roles. | `obsidianmd/obsidian-sample-plugin` |
| `mattslight/oyster-community-apps` | Registry repo containing `community-apps.json`. Single source of truth for both `oyster.to/apps` page and the in-app browser (Tier 3). Authors submit a PR to list. | `obsidianmd/obsidian-releases` |

**oyster.to/apps** — static-hosted page that fetches `community-apps.json` at runtime. Discovery only; install still happens via CLI/in-app. Zero backend.

## References

- Obsidian sample plugin: https://github.com/obsidianmd/obsidian-sample-plugin
- Obsidian plugin docs: https://docs.obsidian.md/Plugins/
- Obsidian community plugins directory: https://obsidian.md/plugins
- BRAT (community install tool): https://github.com/TfTHacker/obsidian42-brat
- Oyster artifact detector: `server/src/artifact-detector.ts`
- Oyster builtins bootstrap: `server/src/index.ts:144-154`
