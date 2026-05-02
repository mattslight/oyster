# Oyster Cloud — user requirements

> **Status (2026-05):** Canonical. Requirements get pinned; architecture is a decision tree. This doc states what we are solving for in language that survives any implementation change.

## Why this doc is separate from design / plan docs

Requirements describe **observable user outcomes**. They have one right shape — a verifiable statement about what the product does for the person using it. They change rarely, and only when our understanding of the user changes.

Architecture and engineering decisions are different. They're trade-offs weighed against complexity, cost, performance, reliability, and viability. There is rarely "one right answer" — there are good answers in context. Those live in `docs/plans/*.md` and evolve as we learn.

If a design decision and a requirement conflict, the requirement wins (or we re-examine the requirement explicitly, not implicitly).

## Two tiers, one substrate

Oyster has a **free account tier** (identity, local workspace, publish/share with caps) and a **Pro tier** (cross-device continuity, durability, recall by meaning across all your conversations, agent-crossing memory). The requirements below describe outcomes in tier-neutral language; the tier mapping at the end maps each to where it's delivered.

The substrate is the same identity layer, the same artefact and memory model, the same recall surface. Pro is an entitlement on top of the free account, not a separate product.

---

## R1. Empty-machine continuity

A user who signs into Oyster on a fresh machine sees their full context with no manual setup — every space pill renders with live counts, sessions list populates, memories are recallable, the inventory tile reflects what's in the cloud. The act of signing in is sufficient; nothing else is required of the user.

**Verify:** clean install + sign-in produces the same Home page as on the user's primary machine, modulo locally-mounted folder contents — the user must still acquire the underlying files separately (e.g. clone a git remote into a local path). No manual import, file copy, or configuration step is required between sign-in and the populated Home page rendering.

**Variant — self-hosted continuity via a git remote.** Users may opt to use their own git remote as the durable copy instead of Oyster's managed cloud. Same R1 outcome, different transport, no trust handed to us. Treated as a first-class option, not a back-door.

**Verify (variant):** with a self-hosted git remote configured on the primary machine, performing the equivalent setup on a fresh machine (install Oyster, point it at the same remote, pull) produces the same Home page as the managed-cloud path, with the same caveats around locally-mounted folder contents and the same no-manual-import constraint.

---

## R2. Conversational recall

A user can ask their agent in natural language about any prior conversation and get back the relevant content. The cross-device extension of this — *regardless of which device the original conversation happened on* — is the Pro upgrade and is captured in the tier mapping; the recall outcome itself applies to both tiers.

Recall has two levels and both must work:

- **Summary-level** (the everyday case): *"Remember that pricing conversation yesterday?"* / *"What did Bharat suggest about memory sync?"* — the answer captures the gist of what was discussed.
- **Verbatim** (the needle-in-the-haystack case): *"What were the exact specs we agreed for the render server?"* / *"What FTS5 schema did we settle on?"* — the answer surfaces the specific phrasing or detail from the original conversation, not just a gesture at the topic.

The natural-language phrasing is the canonical UX. Explicit handles (e.g. `@BLUNDERFIXER:chat-with-bharat`) are at best a power-user fallback, not the primary interface — recall keys on meaning, not literal strings.

**Verify (same-device, applies to free + Pro):** have a conversation; later — same machine, different session — ask the agent in natural language about the topic; the agent responds at both levels, with content traceable to the original. The verbatim case must reproduce specifics a summary alone could not.

**Verify (cross-device, Pro):** the same query works when the original conversation happened on a different signed-in device. *Pick up here* is a special case where the agent is then primed to continue the thread.

---

## R3. Durability against machine loss

If a user's primary machine is destroyed, restoring Oyster on a new machine restores their memories, spaces, artefact manifests, session metadata, session transcripts, and configs.

**Verify:** fresh install + sign-in restores the Home UI to within "locally-mounted folder contents" of the lost machine. Opening any session's inspector on the new machine renders the full transcript of that conversation.

R3 and R1 are closely related — if there is a durable copy of the user's data somewhere reachable, fresh-machine sign-in is just a restore of it.

---

## R4. Memory that crosses agents

A memory written by one AI assistant (Claude, Cursor, Codex, anything connected to Oyster) is recallable by any other. The value is the layer above the agent: Claude won't sync your Cursor sessions; Cursor won't sync your Claude sessions; Oyster does.

**Verify:** one connected agent writes a memory through Oyster; a different connected agent (same user) issues a recall query that surfaces it.

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

## R7. Artefact continuity across devices and across time

Artefacts produced or stored in the user's Oyster vault — mockups, prototypes, presentations, HTML reports, markdown plans, diagrams, decks, apps, any other typed output — are available for the user to open, edit, and continue working with on any signed-in device. Edits propagate so the user is never silently working on a stale copy.

Edits are also **version-controlled**: the user can see the history of an artefact, compare any two versions, and revert to a prior state. The expectation is the same one any developer or AI hacker brings — *"I edited this, I can roll it back."* The mechanism doesn't have to be git; any turnkey approach that delivers history, diff, and revert satisfies the requirement.

**Verify (cross-device):** produce an artefact on Machine A. Sign into Machine B. Open the artefact — the contents match what was last saved on A. Edit it on B; the change is reflected on A on its next sign-in or refresh.

**Verify (across time):** edit an artefact at least twice with distinct content. Open its history; both prior states are visible. Compare any two versions; the differences are shown. Revert to an earlier version; the artefact's current content returns to that state.

**Compound scenario** (anchors R1, R2, R4, R5, R7 together): on Machine A, ask the agent to produce a *competitor analysis matrix* presentation in your vault. Switch to Machine B. Sign in. Ask any connected agent: *"please add a new competitor (Acme Co) to the analysis matrix presentation, then publish it as a password-protected share URL so I can present to my CEO."* The request resolves end-to-end — the agent recognises the artefact (R2/R4), opens its current contents (R7), edits it, publishes to a share URL with password mode (R5), and returns the URL. No manual file copy, no "I'll do that on my other laptop."

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
| R7 Artefact continuity (across devices and across time) | — | ✓ |

The free tier is the identity-and-publishing substrate. Pro is the sync, durability, and cross-device guarantees on top of it.

---

## Pinned architectural principle: agent-facing memory API

The agent-facing API for memory is **MCP, on the local Oyster server** — today and going forward. Cloud doesn't change that. What changes when Pro lands is what's wired behind the MCP tool, not what the agents call.

```
Agent (Claude Code / Cursor / Codex / …)
   │
   │  MCP — `remember`, `recall`, `forget`, `list_memories`
   ▼
Local Oyster server (always running on the user's machine)
   │
   │  free / today: SqliteFtsMemoryProvider → ~/Oyster/db/memory.db
   │  Pro (0.8.0+):  CloudMemoryProvider → Cloudflare D1 + Vectorize
   ▼
Cloud (Pro only)
```

**Why this is pinned:**

- **R4 (memory crosses agents)** is delivered structurally by every connected agent talking to the same MCP. A skill, a CLI, a per-agent HTTP integration would need re-implementing per agent.
- **R2 (recall)** needs FTS + vector queries that aren't realistic over a flat file scan. The MCP boundary lets us put the index where it has to go without leaking that detail to agents.
- **Pro turns on without agent reconfiguration.** Magic-link sign-in (R5 / R1 prereq) flips the local provider from local-SQLite to cloud-backed. Agents see no difference.
- **Offline behaviour is the local server's job.** Writes queue locally; reads serve from local cache. Agents don't need their own retry logic.

**What skills are, and why they're complementary not alternative.** Skills are prompt-layer instructions that tell an agent *when* and *how* to use a tool. They sit on top of an actual transport (MCP, Bash, Read/Write). A skill called *"oyster-memory"* might tell Claude *"when the user shares a durable preference, call `mcp__oyster__remember`"* — useful, and we may publish one alongside the package. But the I/O still goes over MCP.

**What about file-based memory** (the markdown-files-synced-via-git pattern). Real merits — git-syncable, vim-editable, no infrastructure — but as the *agent-facing API* it loses on R2 (no realistic semantic / verbatim recall over a file scan), R4 concurrency (no locking between agents), and Pro mirroring (file-tree-sync vs cloud DB). It can live as an alternative `MemoryProvider` implementation *behind* the MCP surface for power users who want it. It does not replace MCP as the contract.

**Non-MCP consumers** (the local web UI, future CLI scripts, integrations) hit the local HTTP API on top of the same store. Same provider, same consistency, no separate path.

This principle applies to memory specifically; it's the load-bearing decision behind 0.8.0's R4 delivery and worth pinning here so design docs don't re-litigate it.

---

## How to use this doc

- Before starting an architecture/plan doc, check that every decision serves at least one requirement here.
- When proposing a design that doesn't satisfy one of these requirements, that's a flag — either the design needs changing or the requirement needs an explicit re-examination.
- When designing a paywall / entitlement check, look at the tier mapping rather than re-deriving it from the requirement text.
- New requirements get added here only after the same kind of grounded conversation that produced this list. Anything written without a verification clause isn't a requirement yet.
