# generate_artifacts MCP Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `generate_artifacts` MCP tool that gathers structured repo context (key files, project summary, suggested artifacts) so the calling agent can make informed `create_artifact` calls.

**Architecture:** A single self-contained function `gatherRepoContext` added to `mcp-server.ts` alongside the new tool registration. No new files, no schema changes, no new dependencies. The tool reads repo files up to a ~30 k token budget and returns context + deterministic suggestions — the calling LLM does the actual generation via `create_artifact`.

**Tech Stack:** Node.js `fs` (already imported), TypeScript, existing `SpaceService`. No new packages.

**Spec:** `docs/superpowers/specs/2026-03-29-generate-artifacts-mcp-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `server/src/mcp-server.ts` | Modify | Add `gatherRepoContext` helper + `generate_artifacts` tool + update `buildContext` workflow docs |

---

## Task 1: Add `gatherRepoContext` helper function

**Files:** Modify `server/src/mcp-server.ts`

The helper reads a repo's key files within a token budget and derives heuristic suggestions. It is a pure function — no side effects, easy to reason about.

- [ ] **Step 1: Add imports at the top of `mcp-server.ts`**

The file already imports `existsSync`, `readFileSync`, `mkdirSync` from `node:fs`. Add `readdirSync`, `statSync` to that import and add `resolve` to the `node:path` import:

```typescript
import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { extname, dirname, join, resolve, relative } from "node:path";
```

- [ ] **Step 2: Add the `RepoContextResult` type just below the `TEXT_EXTS` constant (line ~17)**

```typescript
interface KeyFile {
  path: string;       // relative to repo root
  content: string;    // may be truncated
  truncated: boolean;
}

interface ArtifactSuggestion {
  kind: "app" | "deck" | "diagram" | "map" | "notes" | "table" | "wireframe";
  label: string;
  rationale: string;
}

interface RepoContextResult {
  space_id: string;
  repo_path: string;
  focus: string | null;
  token_budget_used: number;
  key_files: KeyFile[];
  project_summary: string;
  suggested_artifacts: ArtifactSuggestion[];
}
```

- [ ] **Step 3: Add `gatherRepoContext` function before `buildContext`**

Insert this between the `TEXT_EXTS` constant and the `buildContext` function:

```typescript
const MAX_CHARS_PER_FILE = 4_000;   // ~1 000 tokens per file
const TOKEN_BUDGET = 30_000;         // approx 1 token ≈ 4 chars → 120 000 chars max
const CHARS_PER_TOKEN = 4;

const SKIP_CONTEXT_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".cache",
]);

function gatherRepoContext(repoPath: string, focus: string | null): RepoContextResult {
  let budgetChars = TOKEN_BUDGET * CHARS_PER_TOKEN;
  const keyFiles: KeyFile[] = [];

  function readFile(absPath: string, relPath: string): boolean {
    if (budgetChars <= 0) return false;
    let content: string;
    try {
      content = readFileSync(absPath, "utf8");
    } catch {
      return false;
    }
    const truncated = content.length > MAX_CHARS_PER_FILE;
    const slice = truncated ? content.slice(0, MAX_CHARS_PER_FILE) : content;
    budgetChars -= slice.length;
    keyFiles.push({ path: relPath, content: slice, truncated });
    return true;
  }

  // Priority 1: root README
  const readme = join(repoPath, "README.md");
  if (existsSync(readme)) readFile(readme, "README.md");

  // Priority 2: root manifest (package.json / pyproject.toml / Cargo.toml)
  for (const manifest of ["package.json", "pyproject.toml", "Cargo.toml"]) {
    const p = join(repoPath, manifest);
    if (existsSync(p)) { readFile(p, manifest); break; }
  }

  // Priority 3: entry point heuristic
  const entryPoints = [
    "src/index.ts", "src/main.ts", "src/app.tsx", "src/index.tsx",
    "src/main.py", "main.py", "src/lib.rs", "src/main.rs",
  ];
  for (const ep of entryPoints) {
    const p = join(repoPath, ep);
    if (existsSync(p)) { readFile(p, ep); break; }
  }

  // Priority 4: root CHANGELOG
  const changelog = join(repoPath, "CHANGELOG.md");
  if (existsSync(changelog)) readFile(changelog, "CHANGELOG.md");

  // Priority 5: docs/ .md files (up to 5)
  const docsDir = join(repoPath, "docs");
  if (existsSync(docsDir) && statSync(docsDir).isDirectory()) {
    let count = 0;
    for (const entry of readdirSync(docsDir)) {
      if (count >= 5 || budgetChars <= 0) break;
      if (entry.endsWith(".md")) {
        const p = join(docsDir, entry);
        if (statSync(p).isFile()) { readFile(p, `docs/${entry}`); count++; }
      }
    }
  }

  // Priority 6: src/ .ts/.py/.rs files (up to 5, skip entry already read)
  const srcDir = join(repoPath, "src");
  if (existsSync(srcDir) && statSync(srcDir).isDirectory()) {
    let count = 0;
    for (const entry of readdirSync(srcDir)) {
      if (count >= 5 || budgetChars <= 0) break;
      const ext = extname(entry);
      if ([".ts", ".tsx", ".py", ".rs", ".js"].includes(ext)) {
        const p = join(srcDir, entry);
        const rel = `src/${entry}`;
        if (statSync(p).isFile() && !keyFiles.some(f => f.path === rel)) {
          readFile(p, rel);
          count++;
        }
      }
    }
  }

  // Derive project_summary
  let lang = "unknown";
  let framework = "";
  let description = "";
  const pkgFile = keyFiles.find(f => f.path === "package.json");
  const pyFile  = keyFiles.find(f => f.path === "pyproject.toml");
  const cargoFile = keyFiles.find(f => f.path === "Cargo.toml");

  if (pkgFile) {
    try {
      const pkg = JSON.parse(pkgFile.content) as Record<string, unknown>;
      lang = "TypeScript/JavaScript";
      description = typeof pkg.description === "string" ? pkg.description : "";
      const deps = Object.keys({
        ...(pkg.dependencies as Record<string, unknown> ?? {}),
        ...(pkg.devDependencies as Record<string, unknown> ?? {}),
      });
      if (deps.some(d => d.includes("react"))) framework = "React";
      else if (deps.some(d => d.includes("vue"))) framework = "Vue";
      else if (deps.some(d => d.includes("svelte"))) framework = "Svelte";
      else if (deps.some(d => d.includes("express") || d.includes("fastify"))) framework = "Node.js server";
    } catch { /* malformed */ }
  } else if (pyFile) {
    lang = "Python";
  } else if (cargoFile) {
    lang = "Rust";
  }

  const repoDirName = repoPath.split("/").pop() ?? repoPath;
  const focusPart = focus ? ` (focus: ${focus})` : "";
  const summaryParts = [
    description || repoDirName,
    lang !== "unknown" ? lang : null,
    framework || null,
    `${keyFiles.length} key files read`,
    focusPart || null,
  ].filter(Boolean);
  const project_summary = summaryParts.join(" · ");

  // Derive suggestions heuristically
  const suggestions: ArtifactSuggestion[] = [];
  const readmeFull = keyFiles.find(f => f.path === "README.md");
  if (readmeFull && readmeFull.content.split("\n").length > 80) {
    suggestions.push({
      kind: "notes",
      label: "Getting started guide",
      rationale: "README is long — a distilled quickstart doc aids new contributors",
    });
  }

  const hasSrcFiles = keyFiles.some(f => f.path.startsWith("src/") && !f.path.includes("index"));
  if (hasSrcFiles) {
    suggestions.push({
      kind: "diagram",
      label: "Architecture overview",
      rationale: "Multiple source files detected — a dependency diagram aids onboarding",
    });
  }

  const hasRoutes = keyFiles.some(f => /router|routes|Route|useNavigate/.test(f.content));
  if (hasRoutes) {
    suggestions.push({
      kind: "diagram",
      label: "User flow diagram",
      rationale: "Routing patterns detected in source — a flow diagram maps user journeys",
    });
  }

  if (existsSync(changelog)) {
    suggestions.push({
      kind: "notes",
      label: "Release notes summary",
      rationale: "CHANGELOG present — a summarised release history is useful for stakeholders",
    });
  }

  const hasComponents = existsSync(join(repoPath, "src", "components"));
  if (hasComponents) {
    const compEntries = readdirSync(join(repoPath, "src", "components"));
    if (compEntries.length >= 5) {
      suggestions.push({
        kind: "map",
        label: "Component map",
        rationale: `${compEntries.length} components found — a component map aids UI architecture review`,
      });
    }
  }

  const hasSchema = keyFiles.some(f => /schema|model|prisma|CREATE TABLE/i.test(f.content));
  if (hasSchema) {
    suggestions.push({
      kind: "diagram",
      label: "Data model diagram",
      rationale: "Schema/model definitions detected — an entity diagram aids data design review",
    });
  }

  const tokensUsed = Math.round(keyFiles.reduce((s, f) => s + f.content.length, 0) / CHARS_PER_TOKEN);

  return {
    space_id: "",           // filled in by caller
    repo_path: repoPath,
    focus,
    token_budget_used: tokensUsed,
    key_files: keyFiles,
    project_summary,
    suggested_artifacts: suggestions,
  };
}
```

- [ ] **Step 4: TypeScript check (no test file yet — just verify it compiles)**

```bash
cd server && npx tsc --noEmit
```

Expected: no errors.

---

## Task 2: Register the `generate_artifacts` tool

**Files:** Modify `server/src/mcp-server.ts`

- [ ] **Step 1: Add the tool after the `scan_space` tool (after line ~157)**

Insert this block between the `// ── scan_space ──` closing brace and `// ── list_artifacts ──`:

```typescript
  // ── generate_artifacts ──

  server.tool(
    "generate_artifacts",
    "Gather structured context from a space's repo so you can create meaningful artifacts. Returns key file contents (up to ~30k tokens), a project summary, and deterministic artifact suggestions. Use the returned context to call create_artifact for each artifact you decide to generate. Pass source_origin='ai_generated' convention in your create_artifact calls.",
    {
      space_id: z.string().describe("ID of the space to gather context for"),
      focus: z.string().optional().describe(
        "Optional hint to narrow context, e.g. 'authentication flow' or 'data pipeline'. Included in project_summary."
      ),
    },
    async ({ space_id, focus = null }) => {
      const space = deps.spaceService.getSpace(space_id);
      if (!space) {
        return {
          content: [{ type: "text" as const, text: `Space "${space_id}" not found. Use list_spaces to see available spaces.` }],
          isError: true,
        };
      }
      if (!space.repoPath) {
        return {
          content: [{
            type: "text" as const,
            text: `Space "${space_id}" has no repo_path attached. Use onboard_space to create a repo-backed space, then call generate_artifacts.`,
          }],
          isError: true,
        };
      }
      if (!existsSync(space.repoPath)) {
        return {
          content: [{ type: "text" as const, text: `repo_path does not exist on disk: ${space.repoPath}` }],
          isError: true,
        };
      }

      try {
        const result = gatherRepoContext(space.repoPath, focus);
        result.space_id = space_id;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: (err as Error).message }],
          isError: true,
        };
      }
    },
  );
```

- [ ] **Step 2: TypeScript check**

```bash
cd server && npx tsc --noEmit
```

Expected: no errors.

---

## Task 3: Update `buildContext` workflow documentation

**Files:** Modify `server/src/mcp-server.ts`

- [ ] **Step 1: Update the "Onboarding a project" section in `buildContext`**

Find the `## What agents should do` block in `buildContext` and replace the **Onboarding a project** numbered list with:

```typescript
**Onboarding a project:**
1. Call \`list_spaces\` — check if the space already exists (avoid duplicates).
2. Call \`onboard_space\` with the project name and repo path — creates the space and scans for apps, docs, and diagrams in one step.
3. Call \`list_artifacts\` with the new space_id to see what was discovered.
4. To rescan later (e.g. after new files are added), call \`scan_space\`.
5. To generate richer artifacts (architecture diagrams, user flows, guides), call \`generate_artifacts\` — it returns repo context and suggestions. Then call \`create_artifact\` for each artifact you decide to generate. Use \`source_origin: 'ai_generated'\` convention in your create_artifact call so Oyster can track provenance. These are snapshots, not living docs — regenerate them when the repo changes significantly.
```

- [ ] **Step 2: TypeScript check + confirm server restarts cleanly**

```bash
cd server && npx tsc --noEmit
# Then restart server if running:
# pkill -f "tsx watch" ; npm run dev
```

---

## Task 4: Manual end-to-end test

**Files:** No code changes — curl tests only.

These tests verify the tool works correctly against a running server with a real repo-backed space.

- [ ] **Step 1: Start the server**

```bash
cd server && npm run dev
```

Expected: `Oyster server running on http://localhost:4200`

- [ ] **Step 2: Test — space not found**

```bash
curl -s -X POST http://localhost:4200/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generate_artifacts","arguments":{"space_id":"nonexistent"}}}' \
  | grep '^data:' | sed 's/^data: //' | npx --yes jq '.result.content[0].text'
```

Expected output: `"Space \"nonexistent\" not found. Use list_spaces to see available spaces."`

- [ ] **Step 3: Test — space with no repo_path**

First, create a space without a repo path:
```bash
curl -s -X POST http://localhost:4200/api/spaces \
  -H "Content-Type: application/json" \
  -d '{"name":"no-repo-test"}' | npx --yes jq '.id'
```

Then call generate_artifacts on it:
```bash
curl -s -X POST http://localhost:4200/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generate_artifacts","arguments":{"space_id":"no-repo-test"}}}' \
  | grep '^data:' | sed 's/^data: //' | npx --yes jq '.result.content[0].text'
```

Expected: message about `no repo_path attached`.

Clean up:
```bash
curl -s -X DELETE http://localhost:4200/api/spaces/no-repo-test
```

- [ ] **Step 4: Test — valid repo-backed space**

Find a space with a repo_path (from `list_spaces`):
```bash
curl -s -X POST http://localhost:4200/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_spaces","arguments":{}}}' \
  | grep '^data:' | sed 's/^data: //' | npx --yes jq '[.result.content[0].text | fromjson[] | select(.repoPath != null) | {id, repoPath}]'
```

If no repo-backed space exists, onboard one first:
```bash
curl -s -X POST http://localhost:4200/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"onboard_space\",\"arguments\":{\"name\":\"oyster-os\",\"repo_path\":\"$(pwd)\"}}}" \
  | grep '^data:' | sed 's/^data: //'
```

Then call generate_artifacts:
```bash
SPACE_ID="oyster-os"   # replace with your actual space id
curl -s -X POST http://localhost:4200/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"generate_artifacts\",\"arguments\":{\"space_id\":\"${SPACE_ID}\"}}}" \
  | grep '^data:' | sed 's/^data: //' | npx --yes jq '.result.content[0].text | fromjson | {space_id, token_budget_used, project_summary, key_file_count: (.key_files | length), suggestion_count: (.suggested_artifacts | length)}'
```

Expected: JSON object with `space_id`, `token_budget_used` > 0, non-empty `project_summary`, at least 1 `key_files` entry, 0 or more `suggested_artifacts`.

- [ ] **Step 5: Test — focus param**

```bash
SPACE_ID="oyster-os"
curl -s -X POST http://localhost:4200/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"generate_artifacts\",\"arguments\":{\"space_id\":\"${SPACE_ID}\",\"focus\":\"MCP tooling\"}}}" \
  | grep '^data:' | sed 's/^data: //' | npx --yes jq '.result.content[0].text | fromjson | .project_summary'
```

Expected: `project_summary` contains `"focus: MCP tooling"`.

- [ ] **Step 6: Test — get_context includes generate_artifacts in workflow**

```bash
curl -s -X POST http://localhost:4200/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_context","arguments":{}}}' \
  | grep '^data:' | sed 's/^data: //' | npx --yes jq '.result.content[0].text' | grep -o 'generate_artifacts'
```

Expected: `generate_artifacts`

---

## Task 5: Commit

- [ ] **Step 1: Commit**

```bash
cd /path/to/oyster-os
git add server/src/mcp-server.ts
git commit -m "feat: add generate_artifacts MCP tool (repo context gathering)"
```

---

## Self-Review

**Spec coverage:**
- ✅ `generate_artifacts` tool with `space_id` + optional `focus` params
- ✅ Returns `space_id`, `repo_path`, `focus`, `token_budget_used`, `key_files`, `project_summary`, `suggested_artifacts`
- ✅ Error cases: space not found, no repo_path, repo_path not on disk
- ✅ Token budget strategy: README → manifest → entry point → CHANGELOG → docs/ → src/
- ✅ Suggestion heuristics: README length, src files, routing patterns, CHANGELOG, components, schema
- ✅ `buildContext` updated with step 5 documenting generate_artifacts + `source_origin: 'ai_generated'` convention
- ✅ Only `server/src/mcp-server.ts` modified — no new files, no schema changes, no new packages

**Placeholder scan:** None found.

**Type consistency:** `RepoContextResult`, `KeyFile`, `ArtifactSuggestion` all defined in Task 1 and used consistently in Tasks 2–3.
