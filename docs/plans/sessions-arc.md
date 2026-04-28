# Sessions Arc — 0.5.0 Design

**Status:** active · **Milestone:** [0.5.0](https://github.com/mattslight/oyster/milestone/2) · **Tickets:** [#250–#257](https://github.com/mattslight/oyster/milestone/2)

## What and why

Oyster becomes a reader and visualiser of agent sessions. Today, when a user runs `claude`, `opencode`, or `codex` in a terminal, that session is invisible to Oyster — the work happens, files change, memories accumulate, and Oyster has no idea any of it occurred. The 0.5.0 arc closes that gap.

The hypothesis: a workspace OS that *passively observes* what your agents are doing across projects becomes the place you go to see your day, find things, and resume context — not a replacement for the agents themselves, but the surface that makes them legible.

The user story: I open Oyster and see "2 sessions running, 1 waiting on me in kps, blunderfixer disconnected 14 minutes ago". I click into a session and see what claude-code has been doing in tokinvest while I was at lunch. I see which artefacts it touched, which memories it pulled, which it wrote.

This reframes Oyster's surface. The 0.4.x desktop is a spatial icon grid optimised for browsing artefacts. The 0.5.0 home is a sectioned feed: Spaces · Sessions · Artefacts · Memories — co-equal primitives, scoped by space pills.

## Data model

Three new SQLite tables, additive migrations only.

**`sessions`**
```
id           TEXT PRIMARY KEY     -- session UUID from the source agent
space_id     TEXT NULL            -- nullable: orphan sessions (no matching space) appear unattached on Home
agent        TEXT NOT NULL        -- 'claude-code' | 'opencode' | 'codex'
title        TEXT                 -- derived from first user message; nullable until populated
state        TEXT NOT NULL        -- 'running' | 'awaiting' | 'disconnected' | 'done'
started_at   INTEGER NOT NULL
ended_at     INTEGER NULL
model        TEXT NULL            -- e.g. 'claude-opus-4-7', 'gpt-5'
last_event_at INTEGER NOT NULL    -- drives heartbeat → disconnected detection
```

**`session_events`**
```
id           INTEGER PRIMARY KEY
session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
role         TEXT NOT NULL        -- 'user' | 'assistant' | 'tool' | 'tool_result' | 'system'
text         TEXT NOT NULL        -- rendered transcript line; tool calls are summarised, not raw JSON
timestamp    INTEGER NOT NULL
raw          TEXT NULL            -- original JSONL line (or excerpt) for fidelity / debug
```

**`session_artifacts`**
```
session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
artifact_id  TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE
role         TEXT NOT NULL        -- 'create' | 'modify' | 'read'
when_at      INTEGER NOT NULL
PRIMARY KEY (session_id, artifact_id, role, when_at)
```

The composite key allows the same session to read then later modify the same artefact, recorded as two rows.

## State machine

```
              ┌───────────┐    explicit done event
running   ──▶ │   done    │ ◀─────────────────────────
   ▲          └───────────┘
   │                 ▲
   │                 │ user resolves pending tool approval
   │                 │
   │          ┌───────────┐
   ├────────▶ │ awaiting  │
   │          └───────────┘
   │
   │          ┌──────────────┐    file written to again
   └────────▶ │ disconnected │ ───────────────────────▶ running
              └──────────────┘
```

Transitions:

- **running → awaiting** — the JSONL contains a tool-use event marked as needing approval (claude-code's `pending_approval`-style event, format TBD per release)
- **awaiting → running** — the next event in the JSONL is a tool result, indicating the user resolved the approval
- **running → disconnected** — `last_event_at` is more than 30s old and no `done` marker exists. Heuristic, not authoritative.
- **disconnected → running** — file gets written to again (the user came back)
- *** → done** — explicit session-ended event in the JSONL, or process exit detected

`disconnected` is best-effort. The point isn't precision — it's surfacing "you started something and it stopped" so the user can decide.

## Watcher architecture

Three mechanisms exist for learning about external agent sessions; we're using a layered combination.

| Layer | Mechanism | What it gives us |
|---|---|---|
| Floor | log file watching | zero-config; works for any tool that writes session logs to a known path |
| Ceiling | MCP registration | rich, real-time, opt-in for agents already configured to talk to Oyster |
| Lifecycle | hooks (claude-code only) | clean start/stop signals, doesn't depend on Claude following instructions |

For 0.5.0 we ship the **floor** — log file watching for claude-code and opencode. Hooks and MCP registration are follow-up improvements (own tickets, post-0.5.0).

### claude-code (highest-value target)

Watches `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` via `chokidar`. Each line is a transcript event. The watcher:

1. Boot-time scan — find existing sessions, mark anything older than the disconnect threshold as `done` or `disconnected`
2. Live watch — `add` events for new session files, `change` events for appended lines
3. Parse defensively — unknown event types stored verbatim, not failed
4. Map encoded CWD to `space_id` via the existing `sources` table (looking up by path); unmapped sessions get `space_id = null` and appear orphan on Home
5. Inspect tool calls for known artefact paths → write `session_artifacts` rows

### opencode

Oyster already spawns opencode as a subprocess. Two integration paths to evaluate:
- Direct subprocess tap (capture stdout/stderr, parse inline)
- Session file watching (path TBD)

Prefer the subprocess tap since we already own the process. Same data pipeline as claude-code.

### Risks

- **JSONL format is not a public API.** claude-code can change the schema between releases. Mitigation: parse only what we need (session id, timestamps, role, summarised text), tolerate unknown fields, log unknown event types but don't fail on them. This is an ongoing maintenance liability we accept.
- **"Awaiting" detection is fragile.** Tool-use approval is the trickiest state. Acceptable to ship 0.5.0 without `awaiting` if format inspection during Sprint 2 reveals it's unreliable — `running` will simply persist longer in those cases.

## Home surface

Single page replaces the spatial desktop as the default route.

```
┌─────────────────────────────────────────────────────────────┐
│  HOME                                                        │
│  Today.                                                      │
│  ✦ Most of today's work was on tokinvest's homepage…        │
│                                                              │
│  ┌─tokinvest─┐ ┌─kps─┐ ┌─blunderfixer─┐ ┌─oyster-os─┐       │
│  │ • running │ │     │ │ • disconn'd  │ │            │       │
│  └───────────┘ └─────┘ └──────────────┘ └────────────┘       │
│                                                              │
│  Sessions   • 2 running   • 1 awaiting   • 1 disconnected   │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐                                │
│  │ CC │ │ OC │ │ CC │ │ CX │   …                            │
│  └────┘ └────┘ └────┘ └────┘                                │
│                                                              │
│  Artefacts                                                   │
│  ┌────┐ ┌────┐ ┌────┐ …                                     │
│                                                              │
│  Memories                                                    │
│  ┌─────────────┐ ┌─────────────┐ …                          │
└─────────────────────────────────────────────────────────────┘
   [Home] [tokinvest] [kps] [blunderfixer] [oyster-os] [+]    ← chat-bar pills scope all sections
```

**Section ordering:** Spaces → Sessions → Artefacts → Memories. (Sessions higher than Artefacts because that's the live signal — what's happening *now* — while Artefacts is the durable layer.)

**Space pill behaviour:** selecting a space scopes all three lower sections simultaneously. "Home" pill = no space scope (all artefacts, all sessions, all memories).

**Filter chips inside Sessions:** state-based — running, awaiting, disconnected, done, all. Chips inline with the section header (matching the Memories pattern).

**Inspector panel:** slide-in from the right, shared component for sessions / artefacts / memories. Tabs differ per type.

The current `Desktop.tsx` is gutted (per recent cleanup) into a simple grid with no topbar/sort/filter — it survives as the renderer for the Artefacts section content.

## Sprint sequencing

| # | Sprint | Ticket | Risk |
|---|---|---|---|
| 1 | Session DB schema + migrations | [#250](https://github.com/mattslight/oyster/issues/250) | Low |
| 2 | claude-code JSONL watcher | [#251](https://github.com/mattslight/oyster/issues/251) | **High — load-bearing** |
| 3 | Home surface v1 | [#252](https://github.com/mattslight/oyster/issues/252) | Medium |
| 4 | Inspector panel | [#253](https://github.com/mattslight/oyster/issues/253) | Medium |
| 5 | Memory section on Home | [#254](https://github.com/mattslight/oyster/issues/254) | Low |
| 6 | Artefact↔Session M:N | [#255](https://github.com/mattslight/oyster/issues/255) | Low |
| 7 | opencode watcher | [#256](https://github.com/mattslight/oyster/issues/256) | Medium |
| 8 | AI whisper | [#257](https://github.com/mattslight/oyster/issues/257) | Low–Medium |

Sprint 2 is the load-bearing bet. Everything downstream is UI scaffolding on data that will exist once the watcher works.

## Out of scope

Explicit non-goals for 0.5.0:

- **Agent runtime.** Oyster does not spawn external agents (still does for opencode internally, but that's incidental). Users continue to run claude-code in their terminal.
- **Editing transcripts.** Sessions are read-only — Oyster surfaces them, doesn't modify them.
- **Cross-machine sync.** Sessions are local. A laptop's `~/.claude/projects/` doesn't sync to a desktop's.
- **Hook auto-injection into `~/.claude/settings.json`.** Discussed; deferred. Users wire their own hook config in 0.5.0; auto-injection in onboarding is a follow-up.
- **MCP-based session registration.** Tools like `register_session` / `session_heartbeat` would let agents push state actively. Cleaner than log-watching but requires per-project config. Follow-up.
- **codex watcher.** Listed in conversation but not in the 0.5.0 sprint plan. File a follow-up ticket if/when codex usage justifies it.
- **Search.** The 0.5.0-pre search stack (#231–234) was closed because it was designed for a surface we're replacing. If spotlight needs FTS over the new feed, file a small ticket inside the arc — not its own milestone.

## What this replaces

The 0.4.x → 0.5.0 transition deletes or significantly reworks:

- The spatial desktop topbar (sort / group / align / filter / view-mode controls) — already gone
- `useDragOrder`, `useDesktopPreferences`, `useDesktopSections` — already gone
- The `Grainient` WebGL background — already replaced with CSS gradients + grain
- `applyAgentFilter` and `desktop_filter_changed` SSE event — already obsolete
- The import-from-AI flow (`import.ts`, `/api/import/*`, `builtins/import-from-ai`) — to be deleted; superseded by passive session reading
- The OnboardingDock 3-step flow — likely simplified once sessions auto-register

These cleanups are not blocked on 0.5.0 sprints; they can land independently.
