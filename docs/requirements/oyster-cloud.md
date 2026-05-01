# Oyster Cloud — user requirements

> **Status (2026-05):** Canonical. Requirements get pinned; architecture is a decision tree. This doc states what we are solving for in language that survives any implementation change.

## Why this doc is separate from design / plan docs

Requirements describe **observable user outcomes**. They have one right shape — a verifiable statement about what the product does for the person using it. They change rarely, and only when our understanding of the user changes.

Architecture and engineering decisions are different. They're trade-offs weighed against complexity, cost, performance, reliability, and viability. There is rarely "one right answer" — there are good answers in context. Those live in `docs/plans/*.md` and evolve as we learn.

If a design decision and a requirement conflict, the requirement wins (or we re-examine the requirement explicitly, not implicitly).

## Two tiers, one substrate

Oyster has a **free account tier** (identity, local workspace, publish/share with caps) and a **Pro tier** (cross-device sync, durability, cloud-backed semantic recall, agent-crossing memory). The requirements below describe outcomes in tier-neutral language; the tier mapping at the end maps each to where it's delivered.

The substrate is the same: the same identity layer, the same cloud surface, the same artefact and memory model. Pro is an entitlement on top of the free account, not a separate product.

---

## R1. Empty-machine continuity

A user who signs into Oyster on a fresh machine sees their full context with no manual setup — every space pill renders with live counts, sessions list populates, memories are recallable, the inventory tile reflects what's in the cloud. The act of signing in is sufficient; nothing else is required of the user.

**Verify:** clean install + sign-in produces the same Home page as on the user's primary machine, modulo locally-mounted folder contents (which require their git remote to be cloned to a local path). Transcript bodies of historical sessions are durable per R3 and are pulled on demand when their inspector is opened — they don't need to be on the new machine for the Home page to render. No manual import, file copy, or configuration step is required between sign-in and the populated Home page rendering.

**Variant — self-hosted continuity via a git remote.** Users may opt to use their own git remote as the durable copy instead of Oyster's managed cloud. Same R1 outcome, different transport, no trust handed to us. Treated as a first-class option, not a back-door.

**Verify (variant):** with a self-hosted git remote configured on the primary machine, performing the equivalent setup on a fresh machine (install Oyster, point it at the same remote, pull) produces the same Home page as the managed-cloud path — same modulus, same no-manual-import constraint.

---

## R2. Conversational recall across machines

A user can ask their agent in natural language about any prior conversation, and get back the relevant summary, memories, artefact references, and — when needed — the verbatim transcript content, regardless of which machine the original conversation happened on.

Recall has two levels and both must work:

- **Summary-level** (the everyday case): *"Remember that pricing conversation yesterday?"* / *"What did Bharat suggest about memory sync?"* — answered from the LLM-generated summary plus relevant memories.
- **Verbatim** (the needle-in-the-haystack case): *"What were the exact specs we agreed for the render server?"* / *"What FTS5 schema did we settle on?"* — answered from the actual transcript content, retrieved across the full transcript corpus.

The natural-language phrasing is the canonical UX. Explicit handles (e.g. `@BLUNDERFIXER:chat-with-bharat`) are at best a power-user fallback, not the primary interface — the engine is meaning, not strings.

**Verify:** have a conversation on Machine A; on Machine B, query the agent in natural language about the topic; the agent responds with content traceable to A. The verbatim case must surface the specific phrasing or detail from the original transcript, not just a summary that gestures at the topic. "Pick up here" is a special case where the agent is then primed to continue the thread.

---

## R3. Durability against machine loss

If a user's primary machine is destroyed, restoring Oyster on a new machine restores their memories, spaces, artefact manifests, session metadata, session transcript bodies, and configs from the cloud (or self-hosted remote per R1's variant).

Transcript bodies live in cold storage rather than the live-sync hot path — they are not replicated to every device on every change, but they are **durably stored** and **retrievable on demand** by any signed-in device. The transcript inspector renders the full conversation on a non-origin device by lazy-pulling the bytes from cold storage on first open.

**Verify:** fresh install + sign-in restores the Home UI to within "locally-mounted folder contents" of the lost machine. Opening any session's inspector on the new machine renders the full transcript (after a one-time pull on first open per device).

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

R5 is the reason the **free account tier exists at all**: identity is needed both to publish and to view sign-in-gated content. Caps on free (number of published artefacts, bandwidth, etc.) are pricing detail, not a requirement.

---

## R6. Traceable recall

Whenever Oyster surfaces a memory, session summary, decision, or artefact reference in response to a recall query, the user can see its provenance: the originating conversation, the timestamp, the space it belongs to, and any linked artefacts.

Without this, recall feels magical but is untrustworthy — *"remember what we decided"* gives a confident answer the user has no way to verify. R6 is the difference between a parlour trick and a reliable memory layer.

**Verify:** every recall result exposes a source link / metadata that resolves to the originating session, memory entry, or artefact. The user can click through and read the original context.

R6 is cross-cutting: it applies to free-tier local recall and Pro cross-device recall alike.

---

## Tier mapping

How each requirement is delivered across tiers. Statements above stay tier-neutral; this is the entitlement axis.

| Requirement | Free account | Pro |
|---|---|---|
| R1 Empty-machine continuity | — | ✓ |
| R2 Conversational recall — local-only semantic | ✓ | ✓ |
| R2 Conversational recall — cross-device | — | ✓ |
| R3 Durability against machine loss | — | ✓ |
| R4 Memory that crosses agents | — | ✓ |
| R5 Publish & share (free has caps) | ✓ | ✓ (higher caps) |
| R6 Traceable recall | ✓ | ✓ |

The free tier is the identity-and-publishing substrate. Pro is the sync, durability, and cross-device guarantees on top of it.

---

## How to use this doc

- Before starting an architecture/plan doc, check that every decision serves at least one requirement here.
- When proposing a design that doesn't satisfy one of these requirements, that's a flag — either the design needs changing or the requirement needs an explicit re-examination.
- When designing a paywall / entitlement check, look at the tier mapping rather than re-deriving it from the requirement text.
- New requirements get added here only after the same kind of grounded conversation that produced this list. Anything written without a verification clause isn't a requirement yet.
