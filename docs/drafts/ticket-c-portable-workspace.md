# Portable workspace — preliminary direction

> **🧪 Early thinking. Not a plan, not a commitment.** Captures the shape of the problem so we can refine it before speccing. Expands #94.

## What we know

- **Bharat's core concern** (2026-04-21): local-dev ↔ cloud-sync is the biggest gap. He wants memories, artifacts, and spaces to follow him across devices.
- **Oyster today is single-device, local-only.** Install per machine. No reconcile. Users with a laptop *and* a desktop have two unrelated Oysters.
- **The privacy story from Epic A applies here.** Bharat paused on pasting cloud AI export because it held PII. Any sync story has to respect that — nothing leaves the machine unless the user explicitly opts in.

## Scope (what needs to sync)

- **Artifacts** — registry rows (SQLite) + file blobs on disk. Two-part sync: DB + file content.
- **Memories** — SQLite FTS5 rows. Append-only-ish semantics make sync cheaper.
- **Spaces** — metadata, membership, repo paths. Mostly small row counts.
- **Config** — `opencode.json` and similar. Probably *not* synced — per-machine auth/paths.

## Two models we could choose between

### Model 1 — Local-first with optional cloud relay

Local SQLite is source of truth. A sync daemon replicates events to a relay (self-hostable or Oyster-hosted). Other devices pull events, apply locally.

**Pros:** matches current local-first install model. Stays npm-installable. Privacy-friendly (relay can be user-run on a $5 VPS). Offline-normal.

**Cons:** real engineering — event log, device IDs, conflict resolution, relay protocol, encrypted-at-rest blobs. Self-hostable relay means supporting users setting one up.

### Model 2 — First-class cloud (SaaS flip)

Memories (at minimum) live in a hosted Oyster service. Local client reads/writes through it. Cache for offline.

**Pros:** simpler to build. Cloud-native sync model (done). Opens subscription revenue.

**Cons:** npm install → SaaS means a product-identity shift. Trust story harder for a Reddit audience ("upload my memories to your server"). Costs scale with users.

Bharat's framing (*"local dev ↔ cloud sync"*) leans toward Model 1. Open question.

## Brain-as-plugin sync (if Brain is promoted to first-class plugin)

- Brain has its own SQLite (`memory.db` today).
- Sync strategy is a **plugin contract**, not a hardcoded Oyster behaviour. Brain plugin declares *"I sync via the Oyster sync bus"*, bus handles event replication.
- Plugins without sync support keep working — local-only is the default.
- If Model 2 wins, Brain becomes a client of the Oyster cloud service. If Model 1 wins, Brain plugs into the relay protocol.

## Questions we don't have answers to

- **Model 1 or Model 2?** (biggest decision — shapes everything else)
- **Build or lease?** Turso (hosted SQLite replication), Automerge/Yjs (CRDT libs), S3-compatible for blobs. Do we roll our own or stitch existing pieces?
- **Single-user multi-device only, or multi-user (team) from the start?** Team sync is much harder — CRDTs or OT, permissions, invite flows.
- **What's the upgrade path from today?** Install base is ~3 users. We can break things freely — once it's not three, we can't.
- **Encryption responsibility.** End-to-end with user-held keys (gold standard, lose-the-key = lose-the-data) vs server-held with per-user keys (easier recovery, weaker privacy).

## What we're not doing yet

- Picking a model
- Writing a sync protocol
- Building a relay
- Committing to SaaS

This ticket exists to **hold the shape**. Before we spec or code, we run a dedicated design session on Model 1 vs Model 2 — probably after Epic A ships and Bharat's had more time on Oyster.

## Related

- #94 — Portable workspace (this ticket is an expansion / replacement)
- #20 — Agent sandbox (isolation is a prerequisite for cloud-run agents)
- #30 — Graphiti memory layer (sync for knowledge graph is its own sub-problem)

## Status

- **Now:** document the direction, gather user signal on Model 1 vs Model 2
- **Next:** design session (post Epic A + B)
- **Later:** promote to an epic once we've picked a model

## Why this stays a single ticket, not an epic

This is a **product-identity question** before it's an engineering question: is Oyster primarily a local MCP-driven workspace *with optional sync*, or is it becoming a *hosted workspace product*? Promoting to an epic now would create false certainty about an answer we don't have. A single exploratory ticket is load-bearing here — it holds the shape without committing to a shape.
