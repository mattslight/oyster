# gather_repo_context MCP Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `gather_repo_context` MCP tool that reads a repo's key files within a token budget and returns structured context + deterministic artifact suggestions — so the calling agent can make informed `create_artifact` calls. Also threads `source_origin` through `create_artifact` so agents can mark AI-generated artifacts correctly.

**Architecture:** Two files change. `artifact-service.ts` gets `source_origin` threaded through `registerArtifact` and `createArtifact`. `mcp-server.ts` gets the `gather_repo_context` tool plus a `source_origin` param on the existing `create_artifact` tool. No new files, no schema changes (column already exists), no new packages.

**Tech Stack:** Node.js `fs` (already imported), TypeScript, existing `SpaceService`. No new packages.

**Spec:** `docs/superpowers/specs/2026-03-29-generate-artifacts-mcp-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `server/src/artifact-service.ts` | Modify | Thread `source_origin` through `registerArtifact` + `createArtifact` |
| `server/src/mcp-server.ts` | Modify | Add `source_origin` param to `create_artifact` tool; add `gatherRepoContext` helper + `gather_repo_context` tool; update `buildContext` docs |

---

## Task 1: Thread `source_origin` through artifact-service

**Files:** Modify `server/src/artifact-service.ts`

The `InsertRow` type in `artifact-store.ts` already accepts `source_origin?: "manual" | "discovered" | "ai_generated"`. The service currently hardcodes `"manual"`. This task exposes it as an optional parameter on both `registerArtifact` and `createArtifact`.

- [ ] **Step 1: Add `source_origin` to `registerArtifact` params and pass it to `store.insert`**

Find the `registerArtifact` method signature (line ~102). Change it from:

```typescript
registerArtifact(
  params: {
    path: string;
    space_id: string;
    label: string;
    id?: string;
    artifact_kind?: ArtifactKind;
    group_name?: string;
  },
  approvedRoots: string[],
): Artifact {
```

to:

```typescript
registerArtifact(
  params: {
    path: string;
    space_id: string;
    label: string;
    id?: string;
    artifact_kind?: ArtifactKind;
    group_name?: string;
    source_origin?: "manual" | "discovered" | "ai_generated";
  },
  approvedRoots: string[],
): Artifact {
```

Then update the `this.store.insert({...})` call inside it — change the hardcoded `source_origin: "manual"` line to:

```typescript
      source_origin: params.source_origin ?? "manual",
```

- [ ] **Step 2: Add `source_origin` to `createArtifact` params and pass it through**

Find the `createArtifact` method signature (line ~171). Add `source_origin` to the params interface:

```typescript
  createArtifact(
    params: {
      space_id: string;
      label: string;
      artifact_kind: ArtifactKind;
      content: string;
      subdir?: string;
      group_name?: string;
      source_origin?: "manual" | "discovered" | "ai_generated";
    },
    userlandDir: string,
  ): Artifact {
```

Then find the `this.registerArtifact(...)` call inside `createArtifact` and add `source_origin` to the params object:

```typescript
      return this.registerArtifact(
        {
          path: absPath,
          space_id,
          label,
          artifact_kind: params.artifact_kind,
          group_name: params.group_name,
          id,
          source_origin: params.source_origin,
        },
        [userlandDir],
      );
```

- [ ] **Step 3: TypeScript check**

```bash
cd server && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/artifact-service.ts
git commit -m "feat: thread source_origin through registerArtifact and createArtifact"
```

---

## Task 2: Expose `source_origin` on the `create_artifact` MCP tool

**Files:** Modify `server/src/mcp-server.ts`

- [ ] **Step 1: Add `source_origin` param to the `create_artifact` tool schema**

Find the `create_artifact` tool registration (line ~260). Add to the schema object after `group_name`:

```typescript
      source_origin: z
        .enum(["manual", "discovered", "ai_generated"])
        .optional()
        .describe("Provenance of the artifact. Use 'ai_generated' for artifacts produced by an LLM. Defaults to 'manual'."),
```

- [ ] **Step 2: Destructure `source_origin` in the handler and pass it to `createArtifact`**

Find the handler function signature:

```typescript
    async ({ space_id, label, artifact_kind, content, subdir, group_name }) => {
```

Change to:

```typescript
    async ({ space_id, label, artifact_kind, content, subdir, group_name, source_origin }) => {
```

Then update the `deps.service.createArtifact(...)` call to include it:

```typescript
        const artifact = deps.service.createArtifact(
          { space_id, label, artifact_kind, content, subdir, group_name, source_origin },
          deps.userlandDir,
        );
```

- [ ] **Step 3: TypeScript check**

```bash
cd server && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/mcp-server.ts
git commit -m "feat: expose source_origin param on create_artifact MCP tool"
```

---

## Task 3: Add `gatherRepoContext` helper to `mcp-server.ts`

**Files:** Modify `server/src/mcp-server.ts`

- [ ] **Step 1: Extend the imports**

The file already imports from `node:fs` and `node:path`. Update both lines to add the missing identifiers:

```typescript
import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { extname, dirname, join, resolve, basename } from "node:path";
```

- [ ] **Step 2: Add types and the helper function just above `buildContext`**

Insert this block between the `TEXT_EXTS` constant and the `buildContext` function:

```typescript
// ── gather_repo_context helper ────────────────────────────────────────────

const MAX_CHARS_PER_FILE = 4_000;            // ~1 000 tokens per file
const CONTEXT_TOKEN_BUDGET = 30_000;         // 1 token ≈ 4 chars
const CHARS_PER_TOKEN = 4;

/** File-name patterns that must never appear in context payloads. */
const SKIP_SENSITIVE = new Set([".env", ".envrc", "credentials", "secrets", "secret"]);
const SKIP_SENSITIVE_EXTS = new Set([".pem", ".key", ".cert", ".crt", ".p12", ".pfx"]);
const SKIP_MINIFIED = /\.(min\.js|min\.css|bundle\.js)$/;
const SKIP_GENERATED = /\.(generated\.|\.gen\.)/;
const SKIP_LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Gemfile.lock", "poetry.lock"]);

function isSensitive(filename: string): boolean {
  const base = basename(filename);
  const ext = extname(filename).toLowerCase();
  if (SKIP_SENSITIVE.has(base) || SKIP_SENSITIVE.has(base.replace(/^\./, ""))) return true;
  if (base.startsWith(".env")) return true;
  if (SKIP_SENSITIVE_EXTS.has(ext)) return true;
  if (SKIP_MINIFIED.test(base)) return true;
  if (SKIP_GENERATED.test(base)) return true;
  if (SKIP_LOCKFILES.has(base)) return true;
  return false;
}

interface KeyFile {
  path: string;       // relative to repo root
  content: string;    // may be truncated
  truncated: boolean;
}

interface ArtifactSuggestion {
  kind: "app" | "deck" | "diagram" | "map" | "notes" | "table" | "wireframe";
  label: string;
  rationale: string;
  evidence_paths: string[];   // relative repo paths that triggered this suggestion
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

function gatherRepoContext(repoPath: string, focus: string | null): RepoContextResult {
  let budgetChars = CONTEXT_TOKEN_BUDGET * CHARS_PER_TOKEN;
  const keyFiles: KeyFile[] = [];

  function readFile(absPath: string, relPath: string): boolean {
    if (budgetChars <= 0) return false;
    if (isSensitive(absPath)) return false;
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
  const readmePath = join(repoPath, "README.md");
  if (existsSync(readmePath)) readFile(readmePath, "README.md");

  // Priority 2: root manifest (first match wins)
  for (const manifest of ["package.json", "pyproject.toml", "Cargo.toml"]) {
    const p = join(repoPath, manifest);
    if (existsSync(p)) { readFile(p, manifest); break; }
  }

  // Priority 3: entry point heuristic (first match wins)
  const entryPoints = [
    "src/index.ts", "src/main.ts", "src/app.tsx", "src/index.tsx",
    "src/main.py", "main.py", "src/lib.rs", "src/main.rs",
  ];
  for (const ep of entryPoints) {
    const p = join(repoPath, ep);
    if (existsSync(p)) { readFile(p, ep); break; }
  }

  // Priority 4: root CHANGELOG
  const changelogPath = join(repoPath, "CHANGELOG.md");
  if (existsSync(changelogPath)) readFile(changelogPath, "CHANGELOG.md");

  // Priority 5: docs/ .md files (sorted, up to 5)
  const docsDir = join(repoPath, "docs");
  if (existsSync(docsDir) && statSync(docsDir).isDirectory()) {
    const entries = readdirSync(docsDir).sort();
    let count = 0;
    for (const entry of entries) {
      if (count >= 5 || budgetChars <= 0) break;
      if (isSensitive(entry)) continue;
      if (entry.endsWith(".md")) {
        const p = join(docsDir, entry);
        if (statSync(p).isFile()) { readFile(p, `docs/${entry}`); count++; }
      }
    }
  }

  // Priority 6: src/ source files (sorted, up to 5, skip already-read entry point)
  const srcDir = join(repoPath, "src");
  if (existsSync(srcDir) && statSync(srcDir).isDirectory()) {
    const entries = readdirSync(srcDir).sort();
    let count = 0;
    for (const entry of entries) {
      if (count >= 5 || budgetChars <= 0) break;
      if (isSensitive(entry)) continue;
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

  // ── Derive project_summary ──
  let lang = "unknown";
  let framework = "";
  let description = "";
  const pkgFile   = keyFiles.find(f => f.path === "package.json");
  const pyFile    = keyFiles.find(f => f.path === "pyproject.toml");
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
      if (deps.some(d => d.includes("react")))   framework = "React";
      else if (deps.some(d => d.includes("vue"))) framework = "Vue";
      else if (deps.some(d => d.includes("svelte"))) framework = "Svelte";
      else if (deps.some(d => d.includes("express") || d.includes("fastify"))) framework = "Node.js server";
    } catch { /* malformed package.json — leave defaults */ }
  } else if (pyFile) {
    lang = "Python";
  } else if (cargoFile) {
    lang = "Rust";
  }

  const repoDirName = basename(repoPath) || repoPath;
  const focusPart = focus ? ` · focus: ${focus}` : "";
  const summaryParts = [
    description || repoDirName,
    lang !== "unknown" ? lang : null,
    framework || null,
    `${keyFiles.length} key files read`,
  ].filter(Boolean);
  const project_summary = summaryParts.join(" · ") + focusPart;

  // ── Derive suggestions (deterministic heuristics) ──
  const suggestions: ArtifactSuggestion[] = [];

  const readmeFile = keyFiles.find(f => f.path === "README.md");
  if (readmeFile && readmeFile.content.split("\n").length > 80) {
    suggestions.push({
      kind: "notes",
      label: "Getting started guide",
      rationale: "README exceeds 80 lines — a distilled quickstart aids new contributors",
      evidence_paths: ["README.md"],
    });
  }

  const extraSrcFiles = keyFiles.filter(f =>
    f.path.startsWith("src/") && !["src/index.ts", "src/main.ts", "src/app.tsx", "src/index.tsx"].includes(f.path)
  );
  if (extraSrcFiles.length > 0) {
    suggestions.push({
      kind: "diagram",
      label: "Architecture overview",
      rationale: "Multiple source modules detected — a dependency diagram aids onboarding",
      evidence_paths: extraSrcFiles.map(f => f.path),
    });
  }

  const routeFiles = keyFiles.filter(f => /router|routes|Route|useNavigate|createBrowserRouter/.test(f.content));
  if (routeFiles.length > 0) {
    suggestions.push({
      kind: "diagram",
      label: "User flow diagram",
      rationale: "Routing patterns detected — a flow diagram maps user journeys",
      evidence_paths: routeFiles.map(f => f.path),
    });
  }

  if (existsSync(changelogPath)) {
    suggestions.push({
      kind: "notes",
      label: "Release notes summary",
      rationale: "CHANGELOG present — a summarised history is useful for stakeholders",
      evidence_paths: ["CHANGELOG.md"],
    });
  }

  const componentsDir = join(repoPath, "src", "components");
  if (existsSync(componentsDir) && statSync(componentsDir).isDirectory()) {
    const compEntries = readdirSync(componentsDir).filter(e => !isSensitive(e));
    if (compEntries.length >= 5) {
      suggestions.push({
        kind: "map",
        label: "Component map",
        rationale: `${compEntries.length} components found — a map aids UI architecture review`,
        evidence_paths: ["src/components/"],
      });
    }
  }

  const schemaFiles = keyFiles.filter(f => /schema|model|prisma|CREATE TABLE/i.test(f.content));
  if (schemaFiles.length > 0) {
    suggestions.push({
      kind: "diagram",
      label: "Data model diagram",
      rationale: "Schema or model definitions detected — an entity diagram aids data review",
      evidence_paths: schemaFiles.map(f => f.path),
    });
  }

  const tokensUsed = Math.round(
    keyFiles.reduce((s, f) => s + f.content.length, 0) / CHARS_PER_TOKEN,
  );

  return {
    space_id: "",   // filled in by caller
    repo_path: repoPath,
    focus,
    token_budget_used: tokensUsed,
    key_files: keyFiles,
    project_summary,
    suggested_artifacts: suggestions,
  };
}
```

- [ ] **Step 3: TypeScript check**

```bash
cd server && npx tsc --noEmit
```

Expected: no errors.

---

## Task 4: Register the `gather_repo_context` tool

**Files:** Modify `server/src/mcp-server.ts`

- [ ] **Step 1: Add the tool after the `scan_space` tool, before `list_artifacts`**

Insert this block between the `// ── scan_space ──` closing brace and `// ── list_artifacts ──`:

```typescript
  // ── gather_repo_context ──

  server.tool(
    "gather_repo_context",
    "Read key files from a repo-backed space and return structured context: file contents (up to ~30k tokens), a project summary, and heuristic artifact suggestions. This tool does NOT create artifacts — it gathers context so you can decide what to create via create_artifact. Each suggestion includes evidence_paths showing which files triggered it.",
    {
      space_id: z.string().describe("ID of the space to gather context for"),
      focus: z.string().optional().describe(
        "Optional topic hint to surface in the summary, e.g. 'authentication flow'. Does not filter files."
      ),
    },
    async ({ space_id, focus = null }) => {
      const space = deps.spaceService.getSpace(space_id);
      if (!space) {
        return {
          content: [{ type: "text" as const, text: `Space "${space_id}" not found. Call list_spaces to see available spaces.` }],
          isError: true,
        };
      }
      if (!space.repoPath) {
        return {
          content: [{
            type: "text" as const,
            text: `Space "${space_id}" has no repo_path. Call onboard_space first to attach a local repo.`,
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
          structuredContent: result as unknown as Record<string, unknown>,
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

## Task 5: Update `buildContext` documentation

**Files:** Modify `server/src/mcp-server.ts`

- [ ] **Step 1: Update the "Onboarding a project" numbered list in `buildContext`**

Find the numbered list under `## What agents should do` / `**Onboarding a project:**`. Replace it with:

```typescript
**Onboarding a project:**
1. Call \`list_spaces\` — check if the space already exists (avoid duplicates).
2. Call \`onboard_space\` with the project name and repo path — creates the space and scans for apps, docs, and diagrams in one step.
3. Call \`list_artifacts\` with the new space_id to see what was discovered.
4. To rescan later (e.g. after new files are added), call \`scan_space\`.
5. To generate richer artifacts (architecture diagrams, user flows, guides): call \`gather_repo_context\` to get file context and suggestions, then call \`create_artifact\` for each artifact you decide to make. Pass \`source_origin: "ai_generated"\` so provenance is tracked. These are snapshots — regenerate them when the repo changes significantly.
```

- [ ] **Step 2: Final TypeScript check**

```bash
cd server && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/mcp-server.ts
git commit -m "feat: add gather_repo_context MCP tool + source_origin on create_artifact"
```

---

## Task 6: Manual end-to-end tests

**Files:** No code changes.

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
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"gather_repo_context","arguments":{"space_id":"nonexistent"}}}' \
  | grep '^data:' | sed 's/^data: //' | npx --yes jq '.result.content[0].text'
```

Expected: `"Space \"nonexistent\" not found. Call list_spaces to see available spaces."`

- [ ] **Step 3: Test — space with no repo_path**

```bash
curl -s -X POST http://localhost:4200/api/spaces \
  -H "Content-Type: application/json" \
  -d '{"name":"no-repo-test"}' | npx --yes jq '.id'

curl -s -X POST http://localhost:4200/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"gather_repo_context","arguments":{"space_id":"no-repo-test"}}}' \
  | grep '^data:' | sed 's/^data: //' | npx --yes jq '.result.content[0].text'

curl -s -X DELETE http://localhost:4200/api/spaces/no-repo-test
```

Expected: message about `no repo_path`.

- [ ] **Step 4: Test — valid repo-backed space**

Find or create a repo-backed space:

```bash
# List spaces with repo paths
curl -s -X POST http://localhost:4200/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_spaces","arguments":{}}}' \
  | grep '^data:' | sed 's/^data: //' \
  | npx --yes jq '[.result.content[0].text | fromjson[] | select(.repoPath != null) | {id, repoPath}]'
```

If none exist, onboard one:

```bash
curl -s -X POST http://localhost:4200/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"onboard_space\",\"arguments\":{\"name\":\"oyster-os\",\"repo_path\":\"$(pwd)\"}}}" \
  | grep '^data:' | sed 's/^data: //' | npx --yes jq '.'
```

Call the tool:

```bash
SPACE_ID="oyster-os"   # replace with your actual space id
curl -s -X POST http://localhost:4200/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"gather_repo_context\",\"arguments\":{\"space_id\":\"${SPACE_ID}\"}}}" \
  | grep '^data:' | sed 's/^data: //' \
  | npx --yes jq '.result.content[0].text | fromjson | {space_id, token_budget_used, project_summary, key_file_count: (.key_files | length), suggestion_count: (.suggested_artifacts | length), suggestions: [.suggested_artifacts[] | {label, evidence_paths}]}'
```

Expected: `token_budget_used` > 0, non-empty `project_summary`, ≥ 1 `key_files` entry, each suggestion has `evidence_paths`.

- [ ] **Step 5: Test — focus param appears in summary**

```bash
curl -s -X POST http://localhost:4200/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"gather_repo_context\",\"arguments\":{\"space_id\":\"${SPACE_ID}\",\"focus\":\"MCP tooling\"}}}" \
  | grep '^data:' | sed 's/^data: //' \
  | npx --yes jq '.result.content[0].text | fromjson | .project_summary'
```

Expected: `project_summary` contains `"focus: MCP tooling"`.

- [ ] **Step 6: Test — `source_origin: "ai_generated"` persists via `create_artifact`**

```bash
# Create an artifact with ai_generated provenance
curl -s -X POST http://localhost:4200/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"create_artifact\",\"arguments\":{\"space_id\":\"${SPACE_ID}\",\"label\":\"Test AI doc\",\"artifact_kind\":\"notes\",\"content\":\"# Test\",\"source_origin\":\"ai_generated\"}}}" \
  | grep '^data:' | sed 's/^data: //' | npx --yes jq '.result.content[0].text | fromjson | .id'

# Verify in DB (replace <id> with the id returned above)
sqlite3 server/userland/oyster.db "SELECT id, label, source_origin FROM artifacts WHERE label = 'Test AI doc';"
```

Expected: `source_origin` column shows `ai_generated`.

- [ ] **Step 7: Test — `get_context` references `gather_repo_context`**

```bash
curl -s -X POST http://localhost:4200/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_context","arguments":{}}}' \
  | grep '^data:' | sed 's/^data: //' \
  | npx --yes jq '.result.content[0].text' | grep -o 'gather_repo_context'
```

Expected: `gather_repo_context`

---

## Self-Review

**Spec coverage:**
- ✅ Tool returns `space_id`, `repo_path`, `focus`, `token_budget_used`, `key_files`, `project_summary`, `suggested_artifacts`
- ✅ Each suggestion has `evidence_paths`
- ✅ `structuredContent` returned alongside text
- ✅ Error cases: space not found, no repo_path, path missing from disk
- ✅ Token budget: README → manifest → entry point → CHANGELOG → docs/ → src/
- ✅ File exclusion: `.env*`, `*.pem`, `*.key`, minified, generated, lockfiles
- ✅ `readdirSync` results sorted before iteration
- ✅ `basename(repoPath)` used (not `split("/")`)
- ✅ `SKIP_SENSITIVE` actually enforced via `isSensitive()` — no dead constant
- ✅ `source_origin` threaded through `registerArtifact` + `createArtifact` + MCP `create_artifact` tool
- ✅ `buildContext` updated — references `gather_repo_context` and actual `source_origin` param
- ✅ Tool name `gather_repo_context` — blunt description says it does NOT create artifacts

**Placeholder scan:** None.

**Type consistency:** `RepoContextResult`, `KeyFile`, `ArtifactSuggestion` defined in Task 3 and used consistently in Task 4. `source_origin` union `"manual" | "discovered" | "ai_generated"` matches `ArtifactRow` and `InsertRow` in `artifact-store.ts`.
