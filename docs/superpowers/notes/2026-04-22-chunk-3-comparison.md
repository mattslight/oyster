# Chunk 3 — pipeline comparison results

Run: `cd server && node --env-file=../.env node_modules/.bin/tsx scripts/compare-discovery.ts ~/Dev`
Provider: openai (via `readAuth()`)
Date: 2026-04-22

## Inputs

- **OLD** (`discoverCandidates`): 14 candidates (marker-matched folders only)
- **NEW** (`discoverAllSubfolders`): 16 folders (adds 2 non-marker: `oyster-os.worktrees`, `stockfish`)

## OLD output (`groupWithLLM`, 4274ms, 7 spaces)

| Space | Folders |
|---|---|
| oyster | oyster-community-plugins, oyster-crm, oyster-os, oyster-sample-plugin, oyster-technology-www |
| tokinvest | tokinvest-concept, tokinvest-drc, tokinvest-website |
| blunderfixer | blunderfixer |
| graphiti | graphiti |
| indian-high-court-judgements | indian-high-court-judgements |
| kps-zoho-crm | kps-zoho-crm-mcp |
| other | nanorc, project-notes |

## NEW output (`groupWithLLMRich`, 3899ms, 6 spaces)

| Space | Folders | Note |
|---|---|---|
| oyster | oyster-os, oyster-crm, oyster-technology-www, oyster-community-plugins, oyster-sample-plugin | ✓ |
| tokinvest | tokinvest-concept, tokinvest-drc, tokinvest-website | ✓ |
| other ⚠ | graphiti, stockfish, nanorc | Third-party / configs |
| writing | project-notes, indian-high-court-judgements | Novel grouping |
| skipped | oyster-os.worktrees | Explicit skip (correct) |
| review ⚠ | blunderfixer, kps-zoho-crm-mcp | **LLM silently dropped these; audit recovered** |

## Differences that matter

| Dimension | OLD | NEW | Winner |
|---|---|---|---|
| `oyster-*` grouping | correct | correct | tie |
| `tokinvest-*` grouping | correct | correct | tie |
| `graphiti` classification | own space | "other" (third-party) | **NEW** |
| `stockfish` | invisible | "other" (third-party) | **NEW** |
| `oyster-os.worktrees` | invisible | "skipped" | **NEW** |
| `project-notes` grouping | "other" catch-all | "writing" (grouped w/ indian-high-court-judgements) | **NEW** (more semantic) |
| Silent drops | none (fallback is deterministic) | `blunderfixer` + `kps-zoho-crm-mcp` dropped by LLM, audit recovered to "review" | **OLD** — but see mitigation |
| Latency | 4274 ms | 3899 ms | tie |

## Takeaways

1. **NEW wins on context-aware grouping.** Because it sees the full picture (including non-marker folders and extension hints), it correctly identifies `graphiti`/`stockfish` as third-party and collapses them into "other". OLD can't do this — it only sees marker-matched folders.
2. **NEW handles non-code folders.** It's the only one that sees `oyster-os.worktrees` and `stockfish` at all. Any user whose work isn't 100% code needs this.
3. **Silent drops are real but contained.** The LLM dropped 2 of 16 folders on this run. The audit caught both and put them in a visible "review" bucket. Nothing is lost — it's labelled for the user.
4. **Latency is comparable.** ~4s either way. The marker pre-filter doesn't save meaningful time.

## Recommendation

**Single pipeline: `discoverAllSubfolders` + `groupWithLLMRich`.** Delete the old pair.

The silent-drop concern is real but fits the PRD principle *"ask, don't audit"* — the audit layer already surfaces drops as a visible `review` group. When chunk 5 ships the three-section review UI, users see drops and can promote them back. The LLM's better context-awareness (correctly handling third-party libs, non-code folders, and semantic groupings like "writing") is a clear win.

**Don't add a marker-first short-circuit.** The alternative I proposed (fast-path when all folders have markers) wouldn't help: the big wins of NEW come precisely from SEEING non-marker folders for context. Filtering them out would re-introduce the `graphiti`-as-own-space problem.

## Follow-ups worth tracking (not blockers for chunk 3)

- Prompt tweak: strengthen the "every folder MUST appear" instruction. Already in the prompt; LLM still dropped. Consider adding a confirmation step (LLM reviews its own output) — but cost/latency bump.
- UX for the `review` group: chunk 5 should show it prominently enough that users notice dropped projects. A red-ish accent, not just ⚠.
- Watch the drop rate in UAT. If it's >1 per 10 folders consistently, revisit.
