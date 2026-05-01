# Sync — design direction

> **Status (2026-05):** Design notes. Nothing built yet. Captures the framing pass that happened in conversation on 2026-05-01 so the reasoning survives. Sync is targeted for the 0.7.x arc as part of Oyster Pro.

## TL;DR

Don't sync transcripts. Sync **memories**, plus enough metadata to make hand-off feel magical. Anthropic will ship cloud sessions for Claude Code soon enough — competing on transcript storage is building on quicksand.

## What we're optimising for

The user-visible promise on the pricing page reads:

> Start a conversation on your laptop. Pick it up on your iPad. Your spaces, artifacts, and live sessions follow you between devices — switch mid-thought, no manual export, no version conflicts.

That's **continuity within an active flow**, not "every transcript on every device, forever." Two very different products. The naïve reading is "replicate everything everywhere"; the right reading is "the takeaway from yesterday is available on today's machine."

## Rejected: full bidirectional transcript sync

Original sketch was: every session row replicated, transcripts lazy-loaded from cloud, last-write-wins on metadata, etc.

**Why we're not doing this:**

1. **Anthropic will ship it natively.** Claude.ai is cloud-backed. ChatGPT conversations are cloud-backed. Claude Code being local-only is a stopgap, not a stance — they'll ship cloud sessions + a web UI within 6–12 months. The day they do, our transcript-sync feature is redundant and we look like we built on the wrong layer.
2. **Transcripts are noise.** What carries forward across machines is the *learning*, not the conversation. "Customer prefers email summaries on Fridays" is portable. The 200-line back-and-forth that produced that insight is not.
3. **Bandwidth and storage cost money.** Pulling GBs of transcripts to a phone or tablet that won't read them is anti-product.
4. **Bharat solved it without transcripts.** A peer in the AI agent space implemented cross-device memory continuity using a git-repo-of-MD-files pattern with a Claude Code skill that pushes/pulls. No transcript sync. It worked. (We don't have his code; the pattern is the takeaway.)

## Accepted: memory-first sync

| Layer | Sync behaviour | Rationale |
|---|---|---|
| **Memory** (`remember` / `recall`) | Push/pull, merged across devices, global to the user | This is the real value. Survives any agent vendor's cloud play. The moat is "memory across all your agents." |
| **Spaces** | Replicated, conflict-resolve by user choice (rename / merge) | Organization follows you. |
| **Artefacts (manifest)** | Replicated everywhere | Lets you see what work exists across devices. |
| **Artefacts (blobs)** | Stay on origin device + cloud cold storage. Pull on open. | Most artefact bytes never get opened on another device. |
| **Session transcripts** | Optional cold backup. Not surfaced as a primary feature. | Anthropic will handle this. We don't compete. |
| **Session metadata** (title, started_at, last_event_at, model, cwd, origin_device) | Replicated everywhere | Lets the cross-device session list render without dragging transcripts down. |

The moat here is **memory that persists across agents** — Claude will never sync your Cursor sessions; Cursor will never sync your Claude sessions. Oyster sits one layer above all of them.

## The Bharat pattern (as we understand it)

Rough mental model:

- Each machine has a folder of memory files (Markdown).
- One machine "pushes" — does a diff against the remote, sends the delta.
- Other machines "pull" — get the new files.
- A Claude Code skill reads the local memory folder into context when invoked.

It's git-shaped, but operationally simple. No real-time sync, no conflict-resolution UI, no streaming. Periodic delta pushes from each device, last-write-wins on per-file basis, merge happens in Markdown semantics (which is permissive).

We don't need to copy this exactly. But the principles transfer:

- **File-level granularity, not field-level.** Each memory is a unit; conflicts are file-vs-file, not field-vs-field.
- **Periodic, not realtime.** Sync on a heartbeat or on user-initiated push, not on every keystroke. Cuts complexity by an order of magnitude.
- **Skill-driven recall on the consumer side.** The agent doesn't need a "live database connection" — it pulls fresh memories at session start.

## Hand-off: two flavours, picked per use case

The user named two ways to "continue a conversation on another computer":

### A. Pass through the `.jsonl` directly

Pros:
- Lossless — the new machine sees the exact transcript.
- Cheap: one file copy.
- Familiar mental model: the conversation IS the file.

Cons:
- The new machine's Claude Code can't actually *resume* the JSONL into a live process the way it can resume its own. Resume-by-id only works if the session started on this machine.
- Transcripts get long. Pasting a 500-message conversation into context is a token tax on every reply.
- Doesn't merge with what the new machine already knows.

Use case: archive / read-only review on another device. Niche.

### B. Condensed summary injected at start of new conversation

Pros:
- Token-efficient. Summary is small.
- Plays nicely with how Claude Code already starts new sessions (`-c <id>` resume, `--prompt` priming).
- Forces clarity — the summary is the *what mattered*.
- Composable with memory: the summary references memories, which the agent can `recall` for detail.

Cons:
- Lossy. If the summary missed a detail, you can't recover it without going back to the transcript.
- Quality depends on the summariser.

Use case: *the actual hand-off flow.* "I was working on X, here's the state, here's what I want to do next." This is what 90% of cross-device continuity is.

### Decision

**Default is B (summary injection).** A is available as a fallback ("Pull full transcript to this machine") but not in the primary flow. The button on a session card on another device says **Pick up here**, and that's the summary-injection path.

Implementation sketch:

1. User clicks **Pick up here** on a session in their library on Device B.
2. Oyster fetches the session's metadata + an LLM-generated summary from cloud (cheap, one short string).
3. Oyster also fetches all memories that were touched/written during that session (also small).
4. Oyster spawns a fresh Claude Code session on Device B, primed with: the summary, the relevant memories, the artefact references the session touched. The user is now typing into a "continuation" without the transcript ever leaving the cloud.
5. The new session writes new memories, which sync back globally.

This is *the* demo. The hero shot for Oyster Pro.

## Schema decisions worth making now (forward-compat, free)

Two cheap additive migrations we can land in 0.6.x even before Sync is built. Both are forward-compatible (default NULL, no behaviour change today).

### `sessions.origin_device_id`

A per-install device UUID, stored locally in `~/Oyster/config/device-id` (generated on first run). Tag every session row with the device that originated it.

```sql
ALTER TABLE sessions ADD COLUMN origin_device_id TEXT;
```

Why now: cheap to add; awkward to backfill later. Useful for diagnostics ("which machine ran this?") even before Sync.

### `synced_at INTEGER NULL` on the syncable tables

```sql
ALTER TABLE sessions  ADD COLUMN synced_at INTEGER;
ALTER TABLE memories  ADD COLUMN synced_at INTEGER;
ALTER TABLE artefacts ADD COLUMN synced_at INTEGER;
ALTER TABLE spaces    ADD COLUMN synced_at INTEGER;
```

Why now: lets the future Sync layer know what's been pushed. Default NULL means "not yet synced" so Sync's first run pushes everything new. Free to add today.

### Device identity

Generate `device-id` once on first server start:

```ts
// pseudocode
const path = join(userlandConfigDir, "device-id");
let id = await fs.readFile(path, "utf8").catch(() => null);
if (!id) {
  id = crypto.randomUUID();
  await fs.writeFile(path, id);
}
```

Optionally let user name the device ("MacBook Pro" / "Linux desktop") — surfaced in tooltips, not primary UI.

## What's explicitly NOT in MVP

- **Realtime sync.** Periodic push/pull is enough. Realtime adds operational complexity (websockets, presence, presence-with-conflicts) that's not worth it for this product's actual usage.
- **Transcript sync as a primary feature.** Cold backup is a stretch goal; not in the demo.
- **Cross-user collaboration.** Sync is single-user, multi-device. Sharing is a separate product (the "Publish" primitive on the pricing page).
- **End-to-end encryption.** Listed on the pricing page; we'll need it before charging anyone, but it's an implementation detail of the Sync transport — design separately.

## Open questions

1. **What's the cloud transport?** Three options that fit our existing stack:
   - **Cloudflare D1 + Workers + R2** — mirrors the waitlist worker pattern. R2 for artefact blobs, D1 for memory/metadata, Worker as the API. Cheap, owned, fast. Probably the right answer.
   - **Postgres on Fly/Neon/Supabase** — more expressive querying, established patterns. More moving parts.
   - **Self-host on user's own server** — interesting for the privacy-first crowd. Future, not MVP.

2. **How does memory merge?** Two devices write related memories; how do we deduplicate?
   - **Simplest:** content-hash per memory; identical content → single row. Distinct content → both kept, user can `forget` one later.
   - **Smarter:** semantic similarity threshold. Probably overkill for v1.

3. **Does the user actually want device naming?** Or is "device 3" fine? Probably yes for power users; auto-generated for casuals (e.g. take the OS hostname).

4. **What's the auth boundary?** A signed-in user owns a "tenant"; sync writes scope to that tenant. Magic-link auth from `~/Dev/oyster-crm` is the planned starting point (see `project_pro_auth_plan.md` memory).

## Summary

Sync's MVP is **memory** + **lightweight metadata** + **summary-injection hand-off**. Transcripts are out of scope for the primary feature; Anthropic will absorb that responsibility for Claude. Our value is the layer above the agent — memory that travels across every tool the user touches.

Two cheap schema additions (`origin_device_id`, `synced_at`) buy us future flexibility for free. Ship them in 0.6.x. The rest is post-bundle, post-positioning-research, in 0.7.x territory.
