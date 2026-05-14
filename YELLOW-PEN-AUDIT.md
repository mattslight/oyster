# Oyster — the yellow pens still in the box

*A code-grounded audit against the "Sync · Memory · Publish" pitch*

> *"If the Sony Walkman will play but will not record, everybody can understand what it's for."* — Morita

The pricing page at `oyster.to/pricing` makes a clean three-noun promise. The roadmap (`docs/plans/roadmap.md`) is disciplined to a degree that's rare — every milestone since 0.6.0 is justified against `R1–R7` with a hard rule: *if it isn't on the path to making a requirement true, it doesn't belong on a milestone.* The product story has converged. **The codebase hasn't.** Most of the Sprint-2 product is still shipping inside the Sprint-5 box, hidden underneath but reachable. This report names what I see on disk today and ranks the yellow pens by structural cost.

---

## Method

Walked the full git history (`3a03035` → `3af72dd`, ~3,000 commits), read the canonical roadmap, the R1–R7 requirements doc, the 0.5.0 gap matrix, the archived `sync-direction.md`, the launch-readiness doc, and the live `docs/pricing.html`. Then verified every claim against the actual code under `server/src/`, `web/src/`, `builtins/`, `infra/`, and `bin/`. File:line references throughout.

---

## What Oyster actually ships today (0.8.1-beta.13)

Stripping away the marketing, the *implemented surface* is:

| Layer | Status | Where |
|---|---|---|
| **MCP server at `/mcp/`** | Live, ~35 tools | `server/src/mcp-server.ts` |
| **Claude Code session watcher** | Live; only watcher | `server/src/watchers/claude-code.ts` |
| **Memory store + cross-device sync** | Live (Pro, 0.8.0) | `memory-store.ts`, `memory-sync-service.ts` |
| **Spaces + cross-device sync** | Live (Pro, 0.7.1) | `space-store.ts`, `space-sync-service.ts` |
| **Session metadata + chunked-delta byte sync** | Live (Pro, 0.8.1-beta) | `session-sync-service.ts` |
| **Publish & share** | Live, origin-isolated (0.7.0) | `publish-service.ts`, `infra/oyster-publish` |
| **Auth (OAuth GitHub primary, magic-link fallback)** | Live (0.7.0) | `auth-service.ts`, `infra/auth-worker` |
| **Home feed (sectioned: spaces · sessions · artefacts · memories)** | Live | `web/src/components/Home/` |

Those eight rows are the product as advertised. They cleanly serve the pricing promise.

Then there's everything else still on disk.

---

## The yellow pens I named in the first pass

For context, I previously called out:

1. **Eight artefact kinds** (`app`, `deck`, `notes`, `diagram`, `wireframe`, `table`, `map`) — `deck`/`wireframe`/`map`/`table` are Sprint-2 vestiges with no current generation pipeline visible in the changelog.
2. **Design doc rot** — `docs/plans/oyster-os-design.md` was last edited 2026-04-18 and still describes "Agents on the Surface" and Telegram/WhatsApp ingestion as future vision.
3. **Five competing taglines** across CLAUDE.md, README, design doc, pricing page, and the hero copy.
4. **"Workspace OS"** in the package name when the actual product is a workspace *companion* to agents.

Those are real. They're also surface-level — documentation and labels.

**What I missed runs deeper.** It's structural, and most of it lives in code that gets compiled and shipped on every release.

---

## The big one: the Sprint-2 product is still inside the box

The original Oyster ("a surface where AI generates apps and decks as typed icons") was never deleted when the product pivoted to "the shared brain above your agents." It was laid down underneath. A new user installing today gets *both products* — and the cracks between them are visible in the UI.

### Evidence — seven surfaces of the same yellow pen

**1. Bundled AI agent.** The pricing page lists *"Bring any AI"* as a free-tier feature. Oyster also bundles its own. `server/src/opencode-manager.ts` is 304 lines of subprocess supervision; `opencode-events.ts` (63) and `opencode-orphan-sweep.ts` (115) exist *because* the embedded engine was leaking processes badly enough to warrant a launch-readiness milestone (#191, the orphan-sweep fix). The bin script (`bin/oyster.mjs`) calls `opencode providers login` on first run — Oyster's first install screen is a setup wizard for someone else's product.

**2. In-app chat bar as primary control plane.** `web/src/App.tsx:602` mounts `<ChatBar>` unconditionally. Every artefact creation, memory write, and publish action still flows: user → ChatBar → OpenCode → MCP → server (chat proxy routes at `server/src/index.ts:849–911`). The product *says* "your existing agent connects via MCP at `/mcp/`"; the product also *runs* a different agent and routes its own surface actions through it.

**3. "Ultra Hardcore" terminal gate.** `web/src/App.tsx:543–566` renders a modal whose copy reads, verbatim:

> *"This opens the shell. You're talking directly to the engine — no guardrails, no undo, full control."*

Confirm button: **"Game on."** It's triggered by a terminal icon in the chat bar (`ChatBar.tsx:632`). The window it opens is a real PTY connected via `pty-manager.ts` (126 lines). None of this appears in the changelog after 0.4.x and none of it is on the roadmap. It is a fully functional, lazy-loaded second product accessible by clicking a button in the main UI.

**4. AI-fixes-crashed-artefacts.** `App.tsx:402–422`'s `handleFixError`: when an artefact iframe throws, the user can hand the stack trace to Oyster's bundled chat, which spawns a fresh session and asks the AI to patch the source file. This is the "AI debugger" flow from `e449288` (commit message *"Oyster is debugging"*). It only makes sense in a world where Oyster generates the apps in the first place. In the current product story — "we sit above your agents" — there is nothing to fix; the user's own Claude Code wrote the artefact.

**5. fal.ai icon generator.** `server/src/icon-generator.ts` (263 lines, imported at `index.ts:25`) calls GPT to write a prompt and fal.ai Flux Schnell to render a PNG, per artefact. It runs on every `create_artifact`. The product story has nothing to do with making pretty icons — but the code path still bills $0.003 per icon to a key in `server/.env` on every AI-generated artefact. It signals to a new user that the product is *about* generating visual outputs.

**6. App process manager + `local_process` runtime.** `server/src/process-manager.ts` (169 lines) spawns and supervises external dev servers. `web/src/App.tsx:337–354` is the click handler that calls `startApp()` and opens the app in a popup. This is the Tier-2 vite-runtime story from the design doc (artefacts that need `npm install` + `npx vite`). Per `project_mcp_runtime_gap.md` in your own memory: *"MCP can't register local_process apps; scanner sets no port; existing tiles were hand-SQL'd."* So the code path is *partially-broken legacy* that the current MCP surface can't even target — but the UI still ships the click handler.

**7. `builtins/zombie-horde/`.** A complete HTML browser game (`builtins/zombie-horde/src/index.html`, full CSS theme with `--acid`, `--ember`, `--glow`) shipped as a built-in app and copied into every user's `~/Oyster/apps/` on every boot (`server/src/index.ts` lines 224–231: *"Always re-sync from `builtins/` source"*). Created 2026-03-14, Sprint-2 demo, never removed. **This is the literal yellow pen** — a zombie game in a productivity tool's box.

### Why these seven are one pen, not seven

Each one alone could be excused — *"the terminal is power-user"*, *"the icon generator is cheap"*, *"zombie-horde is harmless cruft."* Together they describe a coherent alternate product:

> *Oyster is an AI-driven app workshop. You chat with our agent, it generates apps with custom icons, you can `local_process`-run them, if they crash the AI debugs them, and a shell-into-the-engine mode is one button away. Also there's a demo zombie game in the box.*

That product is fine. It's just **not the product the roadmap, requirements doc, and pricing page describe.** And a new user installing today gets both shipped on top of each other, with no signal about which is "the real one." That is exactly the 10-Sharpies-plus-one-yellow problem — except scaled to seven yellow pens in the box and a label that lists three colours.

---

## The Morita test, re-applied

Morita pulled the record button off the Walkman not because it didn't work but because *its presence in the picture confused what the product was for.* The seven surfaces above are Oyster's record button. Removing them would not weaken the pricing promise — it would *finally make the pricing promise true on first install*:

- *"Sync"* — unchanged (works).
- *"Memory"* — unchanged (works).
- *"Publish"* — unchanged (works).
- *"Bring any AI"* — finally honest; no bundled chat, no embedded engine, no `opencode providers login` on first run.

The pitch becomes legible the moment the surface stops simultaneously pitching itself.

---

## Concrete moves (ranked by structural impact)

| # | Move | What it unlocks |
|---|---|---|
| 1 | **Retire the in-app chat bar + bundled OpenCode.** Move surface actions (`/s`, `/o`, `/p`, `/u`) into Cmd+K. The user's *own* connected agent (Claude Code, Cursor) is the agent. | Removes ~480 lines of OpenCode supervision; kills the #191 orphan class; deletes the contradiction with *"Bring any AI"*; ~1.5s boot becomes faster still. |
| 2 | **Remove the Ultra Hardcore terminal path** and `pty-manager.ts`. | Removes the "talking directly to the engine" hero copy that contradicts the workspace-companion framing. |
| 3 | **Retire `handleFixError` + `icon-generator.ts`.** | Stops signalling "we generate apps for you"; removes a fal.ai bill the user never asked for. |
| 4 | **Delete `builtins/zombie-horde/`.** Re-evaluate the other five built-ins against R1–R7. `where-are-my-files` earns its place; `quick-start` and `connect-your-ai` probably do; `the-worlds-your-oyster` and `import-from-ai` are worth a second look. | A new user opening `~/Oyster/apps/` no longer sees a zombie game in their productivity tool. |
| 5 | **Collapse the eight artefact kinds** to what users + connected agents actually produce in 2026: `notes`, `app`, `diagram`. Absorb the rest into `notes`. | Removes the visual menu that implies Oyster generates decks/wireframes/maps/tables. |
| 6 | **Archive the Sprint-2 sections of `oyster-os-design.md`** (Agents on Surface, Telegram/WhatsApp, Tier-2 vite runtime). | Aligns the design doc with the roadmap doc. |
| 7 | **Pin one sentence everywhere.** README + CLAUDE.md + boot banner + design doc top all read: *"Every agent, one shared brain. Sync · Memory · Publish."* | The five-tagline ambiguity collapses. |

Move #1 is the load-bearing one. The other six get easier the moment it's done, because they're all surfaces of the same Sprint-2 product. The chat bar is the thing keeping the alternate product alive in the user's read.

---

## What this audit explicitly *isn't*

This is not a quality review. The shipped sync engine is impressive (the chunked-delta + AAD-bound encryption in `session-sync-service.ts` is the kind of thing most "memory tools" never bother to do). The roadmap discipline is rare. R5's origin-isolated share viewer at `share.oyster.to` is the right architecture. None of those are pens of any colour.

The audit is about **one thing**: the gap between *the product as described* and *the product as compiled*. The roadmap doc has already done the hardest piece of the work — there is a clean spine. The codebase just hasn't been told it's allowed to lose the limbs that no longer hang off it.

---

*Audit by: main session*
*Worktree: `~/Dev/oyster-os.worktrees/yellow-pen-report` on branch `report/yellow-pen-audit`*
*Code state: `3af72dd` (0.8.1-beta.13)*
*Date: 2026-05-14*
