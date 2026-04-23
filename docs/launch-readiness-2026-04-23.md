# Launch readiness — 0.4.0-beta.0

Captured 2026-04-23. Readiness items are what has to be true before we press
the Reddit button. Post-readiness (Reddit post → listen → triage) is
deliberately out of scope for this doc and planned separately once readiness
is done.

## Readiness items

### 1. Smoke test 0.4.0-beta.0 on a clean machine

Fresh `npm i -g oyster-os` on a machine that isn't the dev laptop. Walk:

- Connect an external agent (Claude Code) via the dock's step 1 copy flow.
- Ask the agent *"set up Oyster for me"*. Confirm it audits the filesystem,
  proposes a plan in chat, and applies via `onboard_space`.
- Paste the import prompt from step 3 into ChatGPT / Claude; paste the
  response back into Oyster's chat. Confirm spaces + summaries + memories
  land.

**Binary gate.** If anything breaks, fix and re-smoke. Nothing below
matters if this doesn't pass.

### 2. #191 — OpenCode subprocess leak

**Confirmed hit** — happens daily on Matt's laptop (100+ orphan `opencode-ai
serve` processes, 20.9 GB swap, system unusable).

Scope for readiness: **proactive fix — parent-death monitoring.** The child
should terminate itself when its parent (the Oyster server) dies, regardless
of how the parent died (SIGKILL, crash, laptop sleep, OOM). This is the
structurally correct fix — other long-running subprocess hosts (Electron,
PM2, Docker) all handle this at the OS level.

Implementation direction (final shape decided during the work):

- Parent-death detection in the spawned child — on Linux, `prctl(PR_SET_PDEATHSIG, SIGTERM)`;
  on macOS, child polls its own `ppid` and self-terminates when it becomes 1
  (reparented to launchd). A small Node wrapper that supervises the real
  child process is the likely shape.
- Process-group isolation so the restart loop can't race a spawn against a
  not-yet-killed previous child.
- Include a startup orphan sweep as a belt-and-braces safety net — addresses
  any orphans accumulated before this fix lands, bounded to our own userland
  path so no false positives.

Ships as 0.4.0-beta.1. Not a bandaid — the proper fix.

### 3. #185 — userland epic → ship #182 (location visibility)

**Confirmed hit** — Merlin couldn't find his workspace on his Windows install.

Scope for readiness: **#182 only** (location visibility). Move userland out
of the hidden `~/.oyster/` path into somewhere a user naturally expects their
work to live, or surface the location prominently in the UI + docs. Full
design sits in the epic.

### 4. #172 — userland layout

**In readiness.** Once #182 makes userland visible, a user opening the folder
immediately sees the current grab-bag — spaces, artifact directories, system
files (`oyster.db`, `memory.db`, `icons/`, `src/`), and orphan markdown files
all at the root. Shipping location visibility without layout tidy would
expose the mess as a first impression.

Scope: separate user content from system state into clear top-level directories
(final shape decided during the work). Final layout lands with the #185 epic.

## Open decisions

| Question | Decision | Notes |
|---|---|---|
| #191 scope | **Proactive fix** (parent-death monitoring + process-group isolation + startup sweep as belt-and-braces). Not a bandaid. | Decided 2026-04-23. |
| #172 in readiness? | **In.** | Updated 2026-04-23. Shipping #182 (visibility) without #172 (layout) would expose the grab-bag as a first impression. |

## What readiness explicitly is NOT

So we don't drift:

- Reddit post copy, channel selection, or timing
- Landing page rewrite
- oyster-os.com redirect
- #87 builtin icons (icing, not cake)
- #76 topbar overflow (early adopters on desktop)
- Reorg primitives #192 / views-as-queries #193 (gated on Reddit signal)
- Plugin system work (no market pressure yet)

## Done gate

Readiness is done when:

- Smoke test passes cold on a clean machine.
- 0.4.0-beta.1 shipped with the #191 proactive fix.
- #182 location visibility shipped (in 0.4.0-beta.1 or a separate beta, whichever serves the smoke test).
- #172 userland layout shipped alongside #182 so a newly-visible userland doesn't expose the grab-bag.

Post-readiness plan gets written separately once the gate is closed.
