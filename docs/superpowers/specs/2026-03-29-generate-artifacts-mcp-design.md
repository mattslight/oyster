# generate_artifacts MCP Tool — Design Spec

**Date:** 2026-03-29
**Status:** Approved for implementation
**Scope:** Single MCP tool — context gathering only; no autonomous generation, no wizard changes

---

## Problem

After onboarding a space (scan discovers apps, docs, diagrams), there's no way to generate richer knowledge-graph artifacts — user-flow diagrams, architecture overviews, component maps, etc. — without leaving Oyster and asking an LLM from scratch. The agent has to find the repo files itself and decide what to generate.

---

## Goals

- Give agents a single tool that gathers structured repo context (key files, project type, summary) within a token budget
- Return that context + a suggested artifact list so the calling agent can make informed `create_artifact` calls
- Keep generation fully in the agent's hands — no autonomous creation, no new dependencies
- Treat generated artifacts as snapshots: clearly `source_origin: 'ai_generated'`, regeneration is trivial

---

## Out of Scope

- Autonomous generation (the tool returns context, not finished artifacts)
- Wizard step 3 UI changes
- Staleness tracking / stale indicators (later phase)
- Choosing or switching LLMs — generation always happens in the calling agent
- Streaming generation progress

---

## Design

### Core idea

`generate_artifacts` is a **context-gathering tool**. It reads a repo's key files (README, package.json, entry points, etc.) up to a ~30 k token budget, and returns a structured payload:

```json
{
  "space_id": "blunderfixer",
  "repo_path": "/Users/me/Dev/blunderfixer",
  "key_files": [
    { "path": "README.md", "content": "..." },
    { "path": "package.json", "content": "..." },
    { "path": "src/index.ts", "content": "..." }
  ],
  "project_summary": "TypeScript CLI tool for automated PR review. Uses Node 20, Vitest for tests, ships as npm package.",
  "suggested_artifacts": [
    { "kind": "diagram",  "label": "Architecture overview",  "rationale": "Entry point imports 5 modules; a dependency diagram aids onboarding" },
    { "kind": "notes",    "label": "Getting started guide",  "rationale": "README is dense; a distilled quickstart doc adds value" },
    { "kind": "diagram",  "label": "Data flow — PR analysis","rationale": "Core algorithm is non-obvious from filenames alone" }
  ]
}
```

The calling agent (Claude via OpenCode, or any other LLM the user routes through) reads this payload, decides which suggestions to act on, and calls `create_artifact` for each one.

### Why this is the right scope

- **No new dependencies** — no fal.ai, no embedded model, no API key
- **Works with any LLM** — OpenCode, local Ollama, future plugins all see the same tool
- **Agent decides quality** — the LLM generating the content is the same LLM the user already trusts
- **Modularity** — context gathering is stable; generation strategy can vary per agent
- **Honest framing** — snapshots, not living docs; agents can say "this was generated from commit abc1234"

### Token budget strategy

Priority order (stop when ~30 k tokens consumed):
1. `README.md` (root)
2. `package.json` / `pyproject.toml` / `Cargo.toml` (root)
3. Main entry point (heuristic: `src/index.ts`, `src/main.ts`, `src/app.tsx`, `main.py`, etc.)
4. `CHANGELOG.md` (root, if present)
5. Files in `docs/` and `src/` that are ≤ 8 kb, up to 5 files each
6. `.oyster/context.md` if present (future: project-carried context hints)

Token counting is approximate (1 token ≈ 4 chars). Files truncated at 4 k chars each to spread the budget.

### Suggestion heuristics

The tool derives suggestions deterministically from what it reads — no LLM call:

| Signal | Suggested artifact |
|---|---|
| README exists but is > 500 lines | "Getting started guide" notes |
| Multiple `src/` modules imported in entry point | "Architecture overview" diagram |
| Routes array in framework code | "User flow diagram" diagram |
| `CHANGELOG.md` present | "Release notes summary" notes |
| Database schema files present | "Data model" diagram |
| Component directory with ≥ 5 files | "Component map" map |

These are hints for the agent — it may ignore, reorder, or add its own.

---

## Tool Interface

```typescript
server.tool(
  "generate_artifacts",
  "Gather structured context from a space's repo so you can create meaningful artifacts. Returns key file contents, a project summary, and suggested artifact types. Use the returned context to call create_artifact for each artifact you decide to generate.",
  {
    space_id: z.string().describe("ID of the space to gather context for"),
    focus: z.string().optional().describe("Optional hint to narrow context gathering, e.g. 'authentication flow' or 'data pipeline'"),
  },
  async ({ space_id, focus }) => { /* ... */ },
);
```

### Return value (success)

```json
{
  "space_id": "string",
  "repo_path": "string | null",
  "focus": "string | null",
  "token_budget_used": 14200,
  "key_files": [{ "path": "string", "content": "string", "truncated": false }],
  "project_summary": "string",
  "suggested_artifacts": [{ "kind": "string", "label": "string", "rationale": "string" }]
}
```

### Return value (no repo path)

If the space has no `repo_path`, the tool returns an error message explaining that `generate_artifacts` requires a repo-backed space. The agent should prompt the user to run `onboard_space` first.

---

## Provenance

All artifacts created after calling `generate_artifacts` should be passed with `source_origin: 'ai_generated'` in the `create_artifact` call. This is a convention documented in `get_context`, not enforced by the tool — the calling agent is responsible.

The existing `source_origin` column (`'manual' | 'discovered' | 'ai_generated'`) already supports this without schema changes.

---

## Implementation Touchpoints

| File | Change |
|---|---|
| `server/src/mcp-server.ts` | Add `generate_artifacts` tool (≈ 80 lines) |
| `server/src/mcp-server.ts` | Update `get_context` to document `generate_artifacts` in the workflow |
| `shared/types.ts` | No changes needed |
| `server/src/space-service.ts` | No changes needed |

No new files. No schema changes. No new packages.

---

## Workflow (documented in get_context)

```
list_spaces                          → find space_id
onboard_space / scan_space           → discover deterministic artifacts (apps, docs)
generate_artifacts                   → get repo context + suggestions
  → for each suggestion you want:
      create_artifact                → register the generated artifact on the desktop
```

---

## Testing

```bash
# Gather context for an existing space
curl -s -X POST http://localhost:4200/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generate_artifacts","arguments":{"space_id":"blunderfixer"}}}' \
  | grep '^data:' | sed 's/^data: //'

# Expected: JSON with key_files, project_summary, suggested_artifacts

# Space with no repo_path → error message
# Space that doesn't exist → error message
# focus param → project_summary mentions the focus area
```
