# Oyster Pro — user requirements

> **Status (2026-05):** Canonical. Requirements get pinned; architecture is a decision tree. This doc states what we are solving for in language that survives any implementation change.

## Why this doc is separate from design / plan docs

Requirements describe **observable user outcomes**. They have one right shape — a verifiable statement about what the product does for the person using it. They change rarely, and only when our understanding of the user changes.

Architecture and engineering decisions are different. They're trade-offs weighed against complexity, cost, performance, reliability, and viability. There is rarely "one right answer" — there are good answers in context. Those live in `docs/plans/*.md` and evolve as we learn.

If a design decision and a requirement conflict, the requirement wins (or we re-examine the requirement explicitly, not implicitly).

---

## R1. Empty-machine continuity

A user who signs into Oyster on a fresh machine sees their full context within seconds — every space pill renders with live counts, sessions list populates, memories are recallable, the inventory tile reflects what's in the cloud. No setup beyond sign-in.

**Verify:** clean install + sign-in produces the same Home page as on the user's primary machine, modulo locally-mounted folder contents and locally-ingested transcript bodies.

**Variant:** users may opt for **self-hosted continuity via their own git remote** instead of Oyster's managed cloud — same R1/R3 outcome, different transport, no trust handed to us. Treated as a first-class option, not a back-door.

---

## R2. Conversational recall across machines

A user can ask their agent in natural language about any prior conversation, and get back the relevant summary, memories, and artefact references — regardless of which machine the original conversation happened on.

Examples that must work:
- *"Remember that pricing conversation yesterday?"*
- *"What did Bharat suggest about memory sync?"*
- *"Pick up that auth thread we had on the laptop last week."*

The natural-language phrasing is the canonical UX. Explicit handles (e.g. `@BLUNDERFIXER:chat-with-bharat`) are at best a power-user fallback, not the primary interface — the engine is meaning, not strings.

**Verify:** have a conversation on Machine A; on Machine B, query the agent in natural language about the topic; the agent responds with content traceable to A. "Pick up here" is a special case where the agent is then primed to continue the thread.

---

## R3. Durability against machine loss

If a user's primary machine is destroyed, restoring Oyster on a new machine restores their memories, spaces, artefact manifests, session metadata, and configs from the cloud (or self-hosted remote per R1's variant).

**Verify:** fresh install + sign-in restores the Home UI to within "transcripts and locally-mounted file contents" of the lost machine.

R3 and R1 share most of the same plumbing — if the cloud (or remote) is the durable copy, fresh-machine sign-in is just a restore of the same dataset.

---

## R4. Memory that crosses agents

A memory written by one AI assistant (Claude, Cursor, Codex, anything MCP-connected) is recallable by any other. The moat is the layer above the agent: Claude won't sync your Cursor sessions; Cursor won't sync your Claude sessions; Oyster does.

**Verify:** Claude writes a memory through Oyster's MCP; switch to Cursor with the Oyster MCP connected; recall surfaces it.

---

## R5. Publish & share artefacts

Any artefact — markdown plan, HTML mockup, mermaid diagram, app, deck — can be turned into a resolvable URL with three access modes:

- **Open** — anyone with the link can view.
- **Password-protected** — link plus shared password.
- **Sign-in required** — viewer must sign into a free Oyster account. Doubles as the funnel for free signups.

**Verify:** click *Publish* on an artefact, get a URL; opening it in a fresh browser renders correctly under each access mode. Auth-gated mode rejects viewers who aren't signed in and accepts those who are.

R5 implies an **identity layer Oyster doesn't currently have**: a notion of a free Oyster account (no Pro entitlement, just identity) distinct from the local-only model today. Pro then becomes "this account + entitlement," and the auth substrate serves Pro sync, share-link viewing, and any future multi-user feature uniformly.

---

## How to use this doc

- Before starting an architecture/plan doc, check that every decision serves at least one requirement here.
- When proposing a design that doesn't satisfy one of these requirements, that's a flag — either the design needs changing or the requirement needs an explicit re-examination.
- New requirements get added here only after the same kind of grounded conversation that produced this list. Anything written without a verification clause isn't a requirement yet.
