# Cloud AI Import — Design Spec

## Problem

Users have months/years of AI conversation history in ChatGPT, Claude.ai, Gemini etc. containing project context, decisions, and life domains that don't exist on disk. Oyster can scan local files but can't access cloud AI history.

## Solution

A merge-based import flow where the user copies a prompt from Oyster, pastes it into their cloud AI, and pastes the structured response back. Oyster previews what will be created and the user approves.

Every import is a merge operation. The first run is a merge into an empty workspace. Subsequent runs merge new items and skip duplicates.

## Architecture

```
Server builds prompt → User copies to AI → AI responds with JSON
→ User pastes back → Server builds plan → Client approves plan
→ Server executes plan
```

Three API endpoints:
- `GET /api/import/prompt` — generates a context-aware prompt
- `POST /api/import/preview` — validates JSON, dedupes, returns an import plan
- `POST /api/import/execute` — applies the approved plan

## Entry Points

### First run (onboarding banner)

`isFirstRun` = no user-created spaces (exclude `home` and `__all__`). Dismissed state persisted in localStorage.

Banner appears on the surface with two CTAs:
- "Import from AI" → opens the import wizard artifact
- "Scan my machine" → placeholder for future local discovery (#108), disabled in V1
- "skip for now" → dismisses banner (persisted in localStorage). The builtin "Import from AI" card remains on the surface for later use.

Banner component: `web/src/components/OnboardingBanner.tsx` (new).
Rendered by Desktop when `isFirstRun && !dismissed`.

### Builtin artifact (permanent)

"Import from AI" card lives on the home surface as a builtin. Available for re-imports. Contains the 3-step wizard.

## The Wizard (builtin artifact)

Self-contained HTML at `builtins/import-from-ai/src/index.html`. Three steps:

### Step 1: Select provider & copy prompt

- User selects their AI provider: ChatGPT, Claude, Gemini, Other
- Page fetches `GET /api/import/prompt?provider={provider}`
- Displays the generated prompt in a code block (prompt includes provider-specific wording and demands raw JSON only — no markdown fences, no prose before or after)
- "Copy to clipboard" button
- Instruction: "Paste this into {provider}"
- Selected provider is carried through to Step 2 for provenance

### Step 2: Paste response

- Textarea for the AI's JSON response
- "Preview import" button
- Sends `POST /api/import/preview` with the raw pasted text and selected provider
- Server attempts three-stage JSON recovery before failing:
  1. **Regex cleanup** (no tokens): strip markdown fences, leading/trailing prose, BOM
  2. **AI repair** (cheap call): if still invalid, send to OpenCode with "Fix this JSON, return only valid JSON"
  3. **Error**: if repair fails, show the parse error inline with the problematic section highlighted
- The user almost never sees a parse failure

### Step 3: Review & approve

- Shows a summary: spaces with their projects, overview and memory counts
- "Import everything" button (imports all non-skipped actions)
- Sends `POST /api/import/execute` with `plan_id` and all non-skipped `action_ids`

### Post-import

- Close/reset wizard
- Switch to the first space that received new content (new space or existing space that was merged into)
- Show success message with counts

## Import JSON Schema

What the user's AI outputs:

```json
{
  "schema_version": 1,
  "mode": "augment",
  "source": {
    "provider": "chatgpt",
    "generated_at": "2026-04-14T18:00:00Z"
  },
  "spaces": [
    {
      "name": "Work",
      "projects": [
        { "name": "KPS", "summary": "Main operating work." }
      ]
    }
  ],
  "summaries": [
    {
      "space": "Work",
      "title": "Work overview",
      "content": "Active focus is KPS and Digital Mart."
    }
  ],
  "memories": [
    {
      "content": "User prefers organising by life domain first.",
      "tags": ["preference"],
      "space": "Work"
    }
  ]
}
```

Rules:
- `schema_version`: always `1` for now
- `mode`: advisory only — the AI outputs `"fresh"` or `"augment"` but the server derives the real mode from Oyster state (has spaces → augment, no spaces → fresh). The payload value is ignored for logic; it exists so the AI's intent is visible in the raw data.
- `source.provider`: set by the wizard based on user's selection in Step 1, not trusted from the AI output
- `source.generated_at`: best-effort — if missing or invalid, server falls back to import time for provenance and state tracking
- `spaces[].projects`: nested inside spaces, every project belongs to exactly one space
- `summaries[]`: maps to `create_space_overview` actions in the import plan. Each summary becomes the canonical overview artifact for its space.
- `summaries[].space`: must reference a space name from the `spaces` array or an existing space
- `memories[].space`: optional — global if omitted
- Parser must be forgiving: skip malformed items, don't reject the whole payload

## Prompt Generation

`GET /api/import/prompt?provider={provider}` returns a plain text prompt built from a deterministic template + live Oyster context. The server derives the real mode from state — the AI's `mode` field in the response is advisory only.

### Template logic

- **Fresh install** (no user-created spaces): blank-slate prompt asking the AI to suggest full organisation
- **Existing workspace**: augment prompt listing current spaces and known projects, asking AI to map into existing spaces and suggest additions
- **Re-import**: includes `last_import_date` (stored in `~/.oyster/import-state.json` per provider, written only after successful execute — not after preview), asks AI to only include items newer than that date

### What the template includes

- The exact JSON schema (so the AI knows the output format)
- Existing space names (if any)
- Existing project names per space (from previous imports — artifacts with `source_ref` matching `import:*`)
- Last import timestamp for this provider (if any)
- Instructions: durable items only, no prose, no one-off conversational details
- Explicit instruction: output YAML only, no markdown fences, no prose before or after (YAML saves output tokens; the server converts to JSON via OpenCode)
- Provider-specific wording where relevant

## Import Plan

`POST /api/import/preview` accepts the raw pasted text and selected provider, and returns:

```json
{
  "plan_id": "imp_abc123",
  "counts": {
    "new": 4,
    "merge": 1,
    "skipped": 1
  },
  "warnings": [
    "Space 'Build' already exists and will be merged."
  ],
  "actions": [
    {
      "action_id": "act_1",
      "type": "create_space",
      "name": "Work",
      "status": "new"
    },
    {
      "action_id": "act_2",
      "type": "create_space",
      "name": "Build",
      "status": "exists_will_merge"
    },
    {
      "action_id": "act_3",
      "type": "create_project_summary",
      "space": "Work",
      "name": "KPS",
      "summary": "Main operating work.",
      "status": "new",
      "depends_on": "act_1"
    },
    {
      "action_id": "act_4",
      "type": "create_space_overview",
      "space": "Work",
      "title": "Work overview",
      "content": "Active focus is KPS and Digital Mart.",
      "status": "new",
      "depends_on": "act_1"
    },
    {
      "action_id": "act_5",
      "type": "create_memory",
      "content": "User prefers organising by life domain first.",
      "tags": ["preference"],
      "space": "Work",
      "status": "new"
    },
    {
      "action_id": "act_6",
      "type": "create_memory",
      "content": "Deadline is Friday",
      "status": "duplicate_skipped"
    }
  ]
}
```

### Action types

- `create_space` — create a new space
- `create_project_summary` — create a notes artifact summarising a project within a space
- `create_space_overview` — one per space, replaces if exists. The canonical summary of what a space is about.
- `create_memory` — store a durable memory, optionally scoped to a space

### Action statuses

- `new` — will be created
- `exists_will_merge` — space exists, projects/overviews will be added to it
- `duplicate_skipped` — already exists, recommended to skip

### Action dependencies

Actions can have a `depends_on` field referencing another action's `action_id`. This creates parent-child relationships:

- If a user unticks a `create_space` action, the UI auto-unticks all actions that depend on it
- The server rejects orphaned actions on execute (e.g. a project summary for a space that wasn't approved)
- Exception: `exists_will_merge` spaces don't need to be ticked — the space already exists, so children are valid regardless

### Plan TTL

The plan is held in memory on the server (keyed by `plan_id`), valid for 30 minutes.

## Merge Rules

Every import is a merge. Rules per type:

| Type | Match key | Behaviour |
|------|-----------|-----------|
| Space | Slug (normalised name) | If exists: merge projects into it. If new: create. |
| Project summary | Space slug + project name slug | If exists in space: skip. If new: create notes artifact. |
| Space overview | Space slug + `source_ref` containing `overview` | One per space. If exists: replace content. If new: create. |
| Memory | Exact content match in same scope | If exact match: skip. If new: create. |

### "Known projects" definition

The prompt includes existing project names per space. In V1, "known projects" = notes artifacts with `source_ref` matching `import:*` within the space. These are the project summaries created by previous imports. Not arbitrary artifacts.

## Provenance

Every created item carries import provenance for dedup on re-import:

- **Artifacts**: `source_origin: "ai_generated"`, `source_ref: "import:{provider}:{generated_at}"` (e.g. `import:chatgpt:2026-04-14T18:00:00Z`)
- **Memories**: tagged with reserved prefix `_import:{provider}:{generated_at}` (e.g. `_import:chatgpt:2026-04-14`). The `_` prefix marks these as system tags — not displayed in the UI alongside semantic user tags.
- **All items**: `imported_at` timestamp set at creation time (uses existing `created_at` field)

On re-import, merge logic checks `source_ref` / `_import:*` tags before creating to avoid duplicates across import runs.

## Execution

`POST /api/import/execute` accepts:

```json
{
  "plan_id": "imp_abc123",
  "approved_action_ids": ["act_1", "act_3", "act_4", "act_5"]
}
```

Execution is best-effort:
- Each action is attempted independently
- No rollback on partial failure
- Returns per-action results:

```json
{
  "results": [
    { "action_id": "act_1", "status": "created" },
    { "action_id": "act_3", "status": "created" },
    { "action_id": "act_4", "status": "failed", "error": "disk full" },
    { "action_id": "act_5", "status": "created" }
  ],
  "counts": { "created": 3, "failed": 1 }
}
```

### What gets created

- **Spaces** → `spaceService.createSpace({ name })` (existing code)
- **Project summaries** → `artifactService.createArtifact({ space_id, label: name, artifact_kind: "notes", content: summary, source_origin: "ai_generated", source_ref: "import:{provider}:{generated_at}" })`
- **Space overviews** → same as project summaries but with overview title as label, `source_ref` includes `overview` marker for dedup
- **Memories** → `memoryProvider.remember({ content, tags: [...userTags, "_import:{provider}:{generated_at}"], space_id })`

## Privacy

- Pasted JSON is processed locally by Oyster only
- Never re-sent to another LLM
- Not stored raw — only the created artifacts and memories persist
- The import plan is held in memory with a short TTL, then discarded

## Files

| File | Action |
|------|--------|
| `server/src/import.ts` | **NEW** — prompt template, preview logic, execute logic, plan store |
| `server/src/index.ts` | Add 3 routes |
| `builtins/import-from-ai/manifest.json` | **NEW** — builtin manifest |
| `builtins/import-from-ai/src/index.html` | **NEW** — 3-step wizard |
| `web/src/components/OnboardingBanner.tsx` | **NEW** — first-run banner |
| `web/src/components/Desktop.tsx` | Render banner when `isFirstRun` |
| `web/src/App.tsx` | Compute `isFirstRun`, pass to Desktop |

## Future (not V1)

- Prompt bar auto-detect as fallback (hybrid mode)
- Incremental re-import with "only items newer than X" in prompt
- Confidence scoring in schema v2
- Cross-space projects in schema v2
- Auto-sync when ChatGPT exposes MCP

## Verify

1. Fresh install → onboarding banner shows → click "Import from AI" → wizard opens
2. Copy prompt → includes no existing spaces (fresh mode)
3. Paste valid JSON → preview shows plan with checkboxes
4. Approve → spaces, project summaries, space overviews, memories created
5. Post-import → switches to first new space
6. Run import again with same data → duplicates detected and skipped
7. Existing user → prompt includes current spaces (augment mode)
8. Malformed JSON → preview shows inline error, doesn't crash
9. Partial failure → results show which actions failed
