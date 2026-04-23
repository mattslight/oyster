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

Scope for readiness: **reactive startup sweep only.** On server boot, enumerate
running `opencode-ai serve` processes whose cwd is our userland, kill them
before spawning fresh. Bounded to our own userland path — no false positives
against other opencode users.

**Proactive parent-death monitoring is follow-up work**, not readiness. It
prevents new orphans from being created; the reactive sweep cleans up
accumulated harm, which is what's making the laptop unusable today. Ship
reactive for 0.4.0-beta.1; proactive can land on a normal release cadence
after launch.

### 3. #185 — userland epic → ship #182 (location visibility)

**Confirmed hit** — Merlin couldn't find his workspace on his Windows install.

Scope for readiness: **#182 only** (location visibility). Move userland out
of the hidden `~/.oyster/` path into somewhere a user naturally expects their
work to live, or surface the location prominently in the UI + docs. Full
design sits in the epic.

### 4. #172 — userland layout grab-bag

**Out of readiness.** Optional; can be picked up post-launch if Reddit
feedback surfaces it. The location fix (#182) is what Merlin actually hit;
layout (#172) is second-order.

## Open decisions

| Question | Default applied | Flag if different |
|---|---|---|
| #191 scope: reactive sweep only, or reactive + proactive? | **Reactive only** for readiness; proactive is follow-up. | Say so and proactive moves into readiness. |
| #172 in readiness? | **Out.** | Say so and it moves in. |

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
- 0.4.0-beta.1 shipped with #191 reactive sweep.
- #182 location visibility shipped (in 0.4.0-beta.1 or a separate beta, whichever serves the smoke test).

Post-readiness plan gets written separately once the gate is closed.
