# Cloud AI Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users import structured context from cloud AIs (ChatGPT, Claude, Gemini) into Oyster via a copy-prompt → paste-response → preview → approve flow.

**Architecture:** Server generates a context-aware prompt, user pastes it into their AI, pastes the JSON response back. Server builds an import plan (merge-based dedup), client shows checkboxes, server executes approved actions. Three endpoints: `/api/import/prompt`, `/api/import/preview`, `/api/import/execute`.

**Tech Stack:** TypeScript (server), vanilla HTML/CSS/JS (builtin wizard), React (onboarding banner)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `server/src/import.ts` | **NEW** — All import logic: types, prompt template, JSON parsing/recovery, plan building, plan store, execution |
| `server/src/index.ts` | **MODIFY** — Add 3 API routes, wire up import module |
| `builtins/import-from-ai/manifest.json` | **NEW** — Builtin manifest |
| `builtins/import-from-ai/src/index.html` | **NEW** — 3-step wizard (provider select, paste, preview/approve) |
| `web/src/components/OnboardingBanner.tsx` | **NEW** — First-run banner with "Import from AI" CTA |
| `web/src/components/Desktop.tsx` | **MODIFY** — Render banner when `isFirstRun` |
| `web/src/App.tsx` | **MODIFY** — Pass `isFirstRun` to Desktop (already computed at line 185) |
| `web/src/App.css` | **MODIFY** — Banner styles |

---

### Task 1: Import types and plan store

**Files:**
- Create: `server/src/import.ts`

- [ ] **Step 1: Create import.ts with types and plan store**

```typescript
// server/src/import.ts
import { randomUUID } from "node:crypto";

// ── Types ──

export interface ImportPayload {
  schema_version: number;
  mode?: "fresh" | "augment";
  source?: {
    provider?: string;
    generated_at?: string;
  };
  spaces?: Array<{
    name: string;
    projects?: Array<{ name: string; summary: string }>;
  }>;
  summaries?: Array<{
    space: string;
    title: string;
    content: string;
  }>;
  memories?: Array<{
    content: string;
    tags?: string[];
    space?: string;
  }>;
}

export type ActionType = "create_space" | "create_project_summary" | "create_space_overview" | "create_memory";
export type ActionStatus = "new" | "exists_will_merge" | "duplicate_skipped";

export interface ImportAction {
  action_id: string;
  type: ActionType;
  status: ActionStatus;
  name?: string;
  space?: string;
  summary?: string;
  title?: string;
  content?: string;
  tags?: string[];
  depends_on?: string;
}

export interface ImportPlan {
  plan_id: string;
  provider: string;
  generated_at: string;
  counts: { new: number; merge: number; skipped: number };
  warnings: string[];
  actions: ImportAction[];
}

export interface ExecuteResult {
  results: Array<{ action_id: string; status: "created" | "skipped" | "failed"; error?: string }>;
  counts: { created: number; failed: number };
}

// ── Plan Store (in-memory, TTL 10 min) ──

const plans = new Map<string, { plan: ImportPlan; payload: ImportPayload; expires: number }>();
const PLAN_TTL = 10 * 60 * 1000;

export function storePlan(plan: ImportPlan, payload: ImportPayload): void {
  plans.set(plan.plan_id, { plan, payload, expires: Date.now() + PLAN_TTL });
}

export function getPlan(planId: string): { plan: ImportPlan; payload: ImportPayload } | null {
  const entry = plans.get(planId);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    plans.delete(planId);
    return null;
  }
  return { plan: entry.plan, payload: entry.payload };
}

export function deletePlan(planId: string): void {
  plans.delete(planId);
}

// Clean expired plans periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of plans) {
    if (now > entry.expires) plans.delete(id);
  }
}, 60_000);
```

- [ ] **Step 2: Verify it compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add server/src/import.ts
git commit -m "feat(import): add types and in-memory plan store"
```

---

### Task 2: Prompt generation

**Files:**
- Modify: `server/src/import.ts`

- [ ] **Step 1: Add prompt generation function**

Append to `server/src/import.ts`:

```typescript
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Import State ──

const IMPORT_STATE_PATH = join(homedir(), ".oyster", "import-state.json");

interface ImportState {
  [provider: string]: { last_import_date: string };
}

function readImportState(): ImportState {
  try {
    if (existsSync(IMPORT_STATE_PATH)) {
      return JSON.parse(readFileSync(IMPORT_STATE_PATH, "utf8"));
    }
  } catch {}
  return {};
}

export function writeImportDate(provider: string): void {
  const state = readImportState();
  state[provider] = { last_import_date: new Date().toISOString() };
  const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(join(homedir(), ".oyster"), { recursive: true });
  writeFileSync(IMPORT_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

// ── Prompt Generation ──

const JSON_SCHEMA_EXAMPLE = `{
  "schema_version": 1,
  "mode": "fresh",
  "source": {
    "provider": "chatgpt",
    "generated_at": "2026-04-14T18:00:00Z"
  },
  "spaces": [
    {
      "name": "Work",
      "projects": [
        { "name": "Project Name", "summary": "One sentence about this project." }
      ]
    }
  ],
  "summaries": [
    {
      "space": "Work",
      "title": "Work overview",
      "content": "2-3 sentences summarising this space."
    }
  ],
  "memories": [
    {
      "content": "A durable fact, preference, or constraint worth remembering.",
      "tags": ["preference"],
      "space": "Work"
    }
  ]
}`;

export interface PromptContext {
  provider: string;
  spaces: Array<{ id: string; displayName: string }>;
  knownProjects: Map<string, string[]>; // spaceId → project names
}

export function generatePrompt(ctx: PromptContext): string {
  const state = readImportState();
  const lastImport = state[ctx.provider]?.last_import_date;
  const hasSpaces = ctx.spaces.length > 0;

  const mode = hasSpaces ? "augment" : "fresh";

  let prompt = `Based on our past conversations, identify durable workstreams, projects, and long-lived personal contexts that should be organised in a workspace tool.\n\n`;

  if (hasSpaces) {
    prompt += `I already have these spaces set up:\n`;
    for (const s of ctx.spaces) {
      const projects = ctx.knownProjects.get(s.id) || [];
      if (projects.length > 0) {
        prompt += `- ${s.displayName} (projects: ${projects.join(", ")})\n`;
      } else {
        prompt += `- ${s.displayName}\n`;
      }
    }
    prompt += `\nMap into existing spaces where possible. Only suggest new spaces when needed. Do not reorganise what already exists.\n\n`;
  }

  if (lastImport) {
    prompt += `My last import was on ${lastImport}. Only include items that are new or changed since then.\n\n`;
  }

  prompt += `RULES:
- Only include durable items worth keeping: ongoing projects, recurring themes, stable preferences, important decisions.
- Exclude one-off conversational details, temporary questions, or ephemeral topics.
- Every project belongs to exactly one space.
- Summaries: one per space, 2-3 sentences describing what the space is about.
- Memories: durable facts, preferences, or constraints. Not opinions or emotional colour from a single conversation.

OUTPUT FORMAT:
- Output one valid JSON object only.
- No markdown fences. No prose before or after. No explanation.
- Set mode to "${mode}".
- Set source.provider to "${ctx.provider}".
- Set source.generated_at to the current time in ISO 8601 format.

JSON SCHEMA:
${JSON_SCHEMA_EXAMPLE}`;

  return prompt;
}
```

Note: the `writeImportDate` function uses `require` for the write imports to avoid adding them to the top-level import when they're only needed at write time. Alternatively, move the `writeFileSync` and `mkdirSync` imports to the top — either approach works. For cleanliness, move them to the top-level import on line 1 alongside the existing `readFileSync`, `existsSync`.

- [ ] **Step 2: Verify it compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add server/src/import.ts
git commit -m "feat(import): add prompt generation with context-aware template"
```

---

### Task 3: JSON parsing and recovery

**Files:**
- Modify: `server/src/import.ts`

- [ ] **Step 1: Add JSON parsing with three-stage recovery**

Append to `server/src/import.ts`:

```typescript
// ── JSON Parsing & Recovery ──

function stripMarkdownFences(raw: string): string {
  // Remove ```json ... ``` or ``` ... ```
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
  // Remove leading/trailing prose (anything before first { or after last })
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }
  // Remove BOM
  s = s.replace(/^\uFEFF/, "");
  return s;
}

export interface ParseResult {
  success: boolean;
  payload?: ImportPayload;
  error?: string;
  recovered?: boolean;
}

export async function parseImportJSON(
  raw: string,
  aiRepairFn?: (broken: string) => Promise<string | null>,
): Promise<ParseResult> {
  // Stage 1: regex cleanup
  const cleaned = stripMarkdownFences(raw);

  try {
    const parsed = JSON.parse(cleaned);
    return { success: true, payload: parsed as ImportPayload };
  } catch (e1) {
    // Stage 2: AI repair
    if (aiRepairFn) {
      try {
        const repaired = await aiRepairFn(cleaned);
        if (repaired) {
          const repairedCleaned = stripMarkdownFences(repaired);
          const parsed = JSON.parse(repairedCleaned);
          return { success: true, payload: parsed as ImportPayload, recovered: true };
        }
      } catch {}
    }

    // Stage 3: error
    return {
      success: false,
      error: `Invalid JSON: ${(e1 as Error).message}`,
    };
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add server/src/import.ts
git commit -m "feat(import): add three-stage JSON parsing with regex cleanup and AI repair hook"
```

---

### Task 4: Preview — plan building with merge rules

**Files:**
- Modify: `server/src/import.ts`

- [ ] **Step 1: Add the buildImportPlan function**

This is the core merge logic. Append to `server/src/import.ts`:

```typescript
import { slugify } from "./utils.js";

// ── Preview (Plan Building) ──

export interface PreviewDeps {
  getSpaceBySlug: (slug: string) => { id: string; displayName: string } | null;
  getArtifactsBySpace: (spaceId: string) => Array<{ source_ref: string | null; label: string }>;
  findMemory: (content: string, spaceId: string | null) => boolean;
}

export function buildImportPlan(
  payload: ImportPayload,
  provider: string,
  generatedAt: string,
  deps: PreviewDeps,
): ImportPlan {
  const planId = `imp_${randomUUID().slice(0, 12)}`;
  const actions: ImportAction[] = [];
  const warnings: string[] = [];
  let actCounter = 0;
  const nextId = () => `act_${++actCounter}`;

  const sourceRef = (kind: string, name: string) =>
    `import:${provider}:${generatedAt}:${kind}:${slugify(name)}`;

  // ── Spaces ──
  const spaceActionIds = new Map<string, string>(); // space name → action_id

  for (const space of payload.spaces ?? []) {
    if (!space.name) continue;
    const slug = slugify(space.name);
    const existing = deps.getSpaceBySlug(slug);
    const actionId = nextId();
    spaceActionIds.set(space.name, actionId);

    if (existing) {
      actions.push({
        action_id: actionId,
        type: "create_space",
        name: space.name,
        status: "exists_will_merge",
      });
      warnings.push(`Space '${space.name}' already exists and will be merged.`);
    } else {
      actions.push({
        action_id: actionId,
        type: "create_space",
        name: space.name,
        status: "new",
      });
    }

    // ── Projects within this space ──
    for (const project of space.projects ?? []) {
      if (!project.name) continue;
      const spaceId = existing?.id ?? slug;
      const projRef = sourceRef("project", project.name);
      const existingArtifacts = deps.getArtifactsBySpace(spaceId);
      const isDupe = existingArtifacts.some(
        (a) => a.source_ref?.startsWith("import:") && slugify(a.label) === slugify(project.name),
      );

      actions.push({
        action_id: nextId(),
        type: "create_project_summary",
        space: space.name,
        name: project.name,
        summary: project.summary,
        status: isDupe ? "duplicate_skipped" : "new",
        depends_on: existing ? undefined : actionId,
      });
    }
  }

  // ── Space overviews (from summaries[]) ──
  for (const summary of payload.summaries ?? []) {
    if (!summary.space || !summary.content) continue;
    const slug = slugify(summary.space);
    const existing = deps.getSpaceBySlug(slug);
    const spaceId = existing?.id ?? slug;
    const existingArtifacts = deps.getArtifactsBySpace(spaceId);
    const hasOverview = existingArtifacts.some(
      (a) => a.source_ref?.includes("overview"),
    );
    const parentActionId = spaceActionIds.get(summary.space);

    actions.push({
      action_id: nextId(),
      type: "create_space_overview",
      space: summary.space,
      title: summary.title || `${summary.space} overview`,
      content: summary.content,
      status: hasOverview ? "exists_will_merge" : "new",
      depends_on: existing ? undefined : parentActionId,
    });
  }

  // ── Memories ──
  for (const memory of payload.memories ?? []) {
    if (!memory.content) continue;
    const spaceSlug = memory.space ? slugify(memory.space) : null;
    const existingSpace = spaceSlug ? deps.getSpaceBySlug(spaceSlug) : null;
    const spaceId = existingSpace?.id ?? spaceSlug;
    const isDupe = deps.findMemory(memory.content, spaceId);

    actions.push({
      action_id: nextId(),
      type: "create_memory",
      content: memory.content,
      tags: memory.tags,
      space: memory.space,
      status: isDupe ? "duplicate_skipped" : "new",
    });
  }

  const counts = {
    new: actions.filter((a) => a.status === "new").length,
    merge: actions.filter((a) => a.status === "exists_will_merge").length,
    skipped: actions.filter((a) => a.status === "duplicate_skipped").length,
  };

  const plan: ImportPlan = { plan_id: planId, provider, generated_at: generatedAt, counts, warnings, actions };
  storePlan(plan, payload);
  return plan;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add server/src/import.ts
git commit -m "feat(import): add plan building with merge rules and dependency tracking"
```

---

### Task 5: Execute — action execution

**Files:**
- Modify: `server/src/import.ts`

- [ ] **Step 1: Add the executeImportPlan function**

Append to `server/src/import.ts`:

```typescript
// ── Execute ──

export interface ExecuteDeps {
  createSpace: (name: string) => { id: string };
  createArtifact: (params: {
    space_id: string;
    label: string;
    artifact_kind: "notes";
    content: string;
    source_origin: "ai_generated";
    source_ref: string;
  }) => Promise<{ id: string }>;
  remember: (input: { content: string; space_id?: string; tags?: string[] }) => Promise<{ id: string }>;
  getSpaceBySlug: (slug: string) => { id: string } | null;
}

export async function executeImportPlan(
  planId: string,
  approvedIds: string[],
  deps: ExecuteDeps,
): Promise<ExecuteResult> {
  const entry = getPlan(planId);
  if (!entry) {
    return { results: [], counts: { created: 0, failed: 0 } };
  }

  const { plan } = entry;
  const approved = new Set(approvedIds);
  const results: ExecuteResult["results"] = [];
  const createdSpaces = new Map<string, string>(); // space name → space id

  // Validate: reject orphaned actions (depends_on a non-approved, non-merge action)
  for (const action of plan.actions) {
    if (!approved.has(action.action_id)) continue;
    if (action.depends_on) {
      const parent = plan.actions.find((a) => a.action_id === action.depends_on);
      if (parent && parent.status === "new" && !approved.has(parent.action_id)) {
        results.push({
          action_id: action.action_id,
          status: "failed",
          error: `Depends on ${action.depends_on} which was not approved`,
        });
        approved.delete(action.action_id);
      }
    }
  }

  // Execute in order: spaces first, then artifacts, then memories
  const ordered = plan.actions.filter((a) => approved.has(a.action_id));

  for (const action of ordered) {
    try {
      switch (action.type) {
        case "create_space": {
          if (action.status === "exists_will_merge") {
            // Space already exists, just record its ID
            const existing = deps.getSpaceBySlug(slugify(action.name!));
            if (existing) createdSpaces.set(action.name!, existing.id);
            results.push({ action_id: action.action_id, status: "skipped" });
          } else {
            const space = deps.createSpace(action.name!);
            createdSpaces.set(action.name!, space.id);
            results.push({ action_id: action.action_id, status: "created" });
          }
          break;
        }
        case "create_project_summary": {
          const spaceId = resolveSpaceId(action.space!, createdSpaces, deps);
          const ref = `import:${plan.provider}:${plan.generated_at}:project:${slugify(action.name!)}`;
          await deps.createArtifact({
            space_id: spaceId,
            label: action.name!,
            artifact_kind: "notes",
            content: `# ${action.name}\n\n${action.summary || ""}`,
            source_origin: "ai_generated",
            source_ref: ref,
          });
          results.push({ action_id: action.action_id, status: "created" });
          break;
        }
        case "create_space_overview": {
          const spaceId = resolveSpaceId(action.space!, createdSpaces, deps);
          const ref = `import:${plan.provider}:${plan.generated_at}:overview:${slugify(action.space!)}`;
          await deps.createArtifact({
            space_id: spaceId,
            label: action.title || `${action.space} overview`,
            artifact_kind: "notes",
            content: `# ${action.title || action.space}\n\n${action.content || ""}`,
            source_origin: "ai_generated",
            source_ref: ref,
          });
          results.push({ action_id: action.action_id, status: "created" });
          break;
        }
        case "create_memory": {
          const spaceSlug = action.space ? slugify(action.space) : undefined;
          const spaceId = spaceSlug
            ? resolveSpaceId(action.space!, createdSpaces, deps)
            : undefined;
          const importTag = `_import:${plan.provider}:${plan.generated_at.slice(0, 10)}`;
          const tags = [...(action.tags || []), importTag];
          await deps.remember({
            content: action.content!,
            space_id: spaceId,
            tags,
          });
          results.push({ action_id: action.action_id, status: "created" });
          break;
        }
      }
    } catch (err) {
      results.push({
        action_id: action.action_id,
        status: "failed",
        error: (err as Error).message,
      });
    }
  }

  // Write import date only after successful execute
  const created = results.filter((r) => r.status === "created").length;
  if (created > 0) {
    writeImportDate(plan.provider);
  }

  deletePlan(planId);

  return {
    results,
    counts: {
      created,
      failed: results.filter((r) => r.status === "failed").length,
    },
  };
}

function resolveSpaceId(
  spaceName: string,
  createdSpaces: Map<string, string>,
  deps: ExecuteDeps,
): string {
  const fromCreated = createdSpaces.get(spaceName);
  if (fromCreated) return fromCreated;
  const existing = deps.getSpaceBySlug(slugify(spaceName));
  if (existing) return existing.id;
  return slugify(spaceName);
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add server/src/import.ts
git commit -m "feat(import): add plan execution with best-effort per-action results"
```

---

### Task 6: API routes

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: Add import to index.ts**

At the top of `server/src/index.ts`, add to the imports (after the existing import block around line 30):

```typescript
import {
  generatePrompt,
  parseImportJSON,
  buildImportPlan,
  executeImportPlan,
  getPlan,
  type PromptContext,
  type PreviewDeps,
  type ExecuteDeps,
} from "./import.js";
```

- [ ] **Step 2: Add the three routes**

In `server/src/index.ts`, inside the `handleHttpRequest` function, add before the existing `// ── Static files ──` section (which is the fallback). Find the section where other API routes are defined and add:

```typescript
  // ── Import routes ──

  if (url.startsWith("/api/import/prompt") && req.method === "GET") {
    const params = new URL(url, "http://localhost").searchParams;
    const provider = params.get("provider") || "chatgpt";

    const allSpaces = spaceStore.getAll()
      .filter((s) => s.id !== "home" && s.id !== "__all__")
      .map((s) => ({ id: s.id, displayName: s.display_name }));

    const knownProjects = new Map<string, string[]>();
    for (const s of allSpaces) {
      const artifacts = store.getBySpaceId(s.id)
        .filter((a) => a.source_ref?.startsWith("import:") && !a.removed_at);
      if (artifacts.length > 0) {
        knownProjects.set(s.id, artifacts.map((a) => a.label));
      }
    }

    const prompt = generatePrompt({ provider, spaces: allSpaces, knownProjects });
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(prompt);
    return;
  }

  if (url === "/api/import/preview" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { raw, provider } = JSON.parse(body) as { raw: string; provider: string };

        const parseResult = await parseImportJSON(raw);
        if (!parseResult.success || !parseResult.payload) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: parseResult.error }));
          return;
        }

        const generatedAt = parseResult.payload.source?.generated_at || new Date().toISOString();

        const previewDeps: PreviewDeps = {
          getSpaceBySlug: (slug) => {
            const row = spaceStore.getAll().find((s) => s.id === slug);
            return row ? { id: row.id, displayName: row.display_name } : null;
          },
          getArtifactsBySpace: (spaceId) => {
            return store.getBySpaceId(spaceId)
              .filter((a) => !a.removed_at)
              .map((a) => ({ source_ref: a.source_ref, label: a.label }));
          },
          findMemory: (content, spaceId) => {
            try {
              return memoryProvider.findExact(content, spaceId ?? undefined);
            } catch {
              return false;
            }
          },
        };

        const plan = buildImportPlan(parseResult.payload, provider, generatedAt, previewDeps);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(plan));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    return;
  }

  if (url === "/api/import/execute" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { plan_id, approved_action_ids } = JSON.parse(body) as {
          plan_id: string;
          approved_action_ids: string[];
        };

        if (!getPlan(plan_id)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Plan not found or expired" }));
          return;
        }

        const executeDeps: ExecuteDeps = {
          createSpace: (name) => spaceService.createSpace({ name }),
          createArtifact: (params) => artifactService.createArtifact(params, USERLAND_DIR),
          remember: (input) => memoryProvider.remember(input),
          getSpaceBySlug: (slug) => {
            const row = spaceStore.getAll().find((s) => s.id === slug);
            return row ? { id: row.id } : null;
          },
        };

        const result = await executeImportPlan(plan_id, approved_action_ids, executeDeps);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    return;
  }
```

- [ ] **Step 3: Add `findExact` to memory provider if not exposed**

The preview route uses `memoryProvider.findExact()`. Check if `SqliteFtsMemoryProvider` exposes this. If not, add a public method in `server/src/memory-store.ts`:

```typescript
findExact(content: string, spaceId?: string): boolean {
  const row = this.stmts.findExact.get(content, spaceId ?? null, spaceId ?? null);
  return !!row;
}
```

The prepared statement already exists (line 137 in memory-store.ts).

- [ ] **Step 4: Verify it compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts server/src/import.ts server/src/memory-store.ts
git commit -m "feat(import): add /api/import/prompt, preview, execute routes"
```

---

### Task 7: Builtin wizard — Import from AI

**Files:**
- Create: `builtins/import-from-ai/manifest.json`
- Create: `builtins/import-from-ai/src/index.html`

- [ ] **Step 1: Create manifest**

```json
{
  "id": "import-from-ai",
  "name": "Import from AI",
  "type": "notes",
  "runtime": "static",
  "entrypoint": "src/index.html",
  "ports": [],
  "storage": "none",
  "capabilities": [],
  "status": "ready",
  "builtin": true,
  "created_at": "2026-04-14T00:00:00.000Z",
  "updated_at": "2026-04-14T00:00:00.000Z"
}
```

- [ ] **Step 2: Create the wizard HTML**

Create `builtins/import-from-ai/src/index.html` — a self-contained HTML page with inline CSS and JS. Must match the Oyster dark theme (bg: `#0a0b14`, fonts: Space Grotesk + IBM Plex Mono, accent: `#7c6bff`).

The page has three steps controlled by JS state:

**Step 1 — Provider select + copy prompt:**
- Four radio buttons: ChatGPT, Claude, Gemini, Other
- On provider select, fetch `GET /api/import/prompt?provider={provider}`
- Display prompt in a scrollable `<pre>` block
- "Copy to clipboard" button
- "Next" button to advance to step 2

**Step 2 — Paste response:**
- Large `<textarea>` with placeholder "Paste your AI's response here"
- "Preview import" button
- On click: POST `/api/import/preview` with `{ raw: textarea.value, provider }`
- Show spinner while loading
- On error: show error message inline (red text below textarea)
- On success: advance to step 3 with plan data

**Step 3 — Review & approve:**
- Show `counts` summary at top: "X new, Y merge, Z skipped"
- Show `warnings` if any (amber text)
- List each action as a checkbox row:
  - Pre-checked for `new` and `exists_will_merge`
  - Unchecked for `duplicate_skipped`
  - Indented for actions with `depends_on`
  - Unticking a parent auto-unticks children
- "Import selected" button
- On click: POST `/api/import/execute` with `{ plan_id, approved_action_ids }`
- On success: show counts, then redirect to first new space via `/api/ui/command` or `window.location`

The HTML should be ~300-400 lines. Follow the style patterns from `builtins/connect-your-ai/src/index.html` and `builtins/quick-start/src/index.html` (dark theme, same fonts, same spacing).

- [ ] **Step 3: Commit**

```bash
git add builtins/import-from-ai/
git commit -m "feat(import): add Import from AI builtin wizard"
```

---

### Task 8: Onboarding banner

**Files:**
- Create: `web/src/components/OnboardingBanner.tsx`
- Modify: `web/src/components/Desktop.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.css`

- [ ] **Step 1: Create OnboardingBanner component**

```tsx
// web/src/components/OnboardingBanner.tsx
import { useState } from "react";

interface Props {
  onImportFromAI: () => void;
  onDismiss: () => void;
}

export function OnboardingBanner({ onImportFromAI, onDismiss }: Props) {
  return (
    <div className="onboarding-banner">
      <div className="onboarding-banner-content">
        <h2>Set up your workspace</h2>
        <p>Bring in your projects and context from other tools.</p>
        <div className="onboarding-banner-actions">
          <button className="onboarding-btn-primary" onClick={onImportFromAI}>
            Import from AI
          </button>
          <button className="onboarding-btn-secondary" disabled title="Coming soon">
            Scan my machine
          </button>
        </div>
        <button className="onboarding-dismiss" onClick={onDismiss}>
          skip for now
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add banner styles to App.css**

Add to `web/src/App.css`:

```css
.onboarding-banner {
  display: flex;
  justify-content: center;
  padding: 32px 16px 0;
}
.onboarding-banner-content {
  max-width: 440px;
  background: rgba(124, 107, 255, 0.06);
  border: 1px solid rgba(124, 107, 255, 0.15);
  border-radius: 16px;
  padding: 28px 32px;
  text-align: center;
}
.onboarding-banner-content h2 {
  font-size: 18px;
  font-weight: 600;
  color: #fff;
  margin-bottom: 6px;
}
.onboarding-banner-content p {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.5);
  margin-bottom: 20px;
}
.onboarding-banner-actions {
  display: flex;
  gap: 8px;
  justify-content: center;
  margin-bottom: 12px;
}
.onboarding-btn-primary {
  background: #7c6bff;
  color: #fff;
  border: none;
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.onboarding-btn-primary:hover {
  background: #6b5ce6;
}
.onboarding-btn-secondary {
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.4);
  border: none;
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 14px;
  cursor: not-allowed;
  font-family: inherit;
}
.onboarding-dismiss {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.25);
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}
.onboarding-dismiss:hover {
  color: rgba(255, 255, 255, 0.5);
}
```

- [ ] **Step 3: Wire up in Desktop.tsx**

In `web/src/components/Desktop.tsx`:

1. Add import at top:
```typescript
import { OnboardingBanner } from "./OnboardingBanner";
```

2. Add dismissed state:
```typescript
const [bannerDismissed, setBannerDismissed] = useState(
  () => localStorage.getItem("oyster-onboarding-dismissed") === "true"
);
```

3. Add dismiss handler:
```typescript
const handleDismiss = () => {
  localStorage.setItem("oyster-onboarding-dismissed", "true");
  setBannerDismissed(true);
};
```

4. Render banner before the filter bar (inside desktop-scroll, before the first child):
```tsx
{isFirstRun && !bannerDismissed && (
  <OnboardingBanner
    onImportFromAI={() => {
      // Open the import-from-ai builtin artifact
      const importArtifact = artifacts.find((a) => a.id === "import-from-ai");
      if (importArtifact) onArtifactClick(importArtifact);
    }}
    onDismiss={handleDismiss}
  />
)}
```

- [ ] **Step 4: Ensure isFirstRun is passed to Desktop in App.tsx**

Check `web/src/App.tsx` line 185 — `isFirstRun` is already computed. Verify it's passed to the `<Desktop>` component in the JSX. If not, add `isFirstRun={isFirstRun}` to the Desktop props.

- [ ] **Step 5: Verify it compiles**

Run: `cd web && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add web/src/components/OnboardingBanner.tsx web/src/components/Desktop.tsx web/src/App.tsx web/src/App.css
git commit -m "feat(import): add first-run onboarding banner with Import from AI CTA"
```

---

### Task 9: Integration test — end-to-end manual verification

- [ ] **Step 1: Start dev server**

```bash
npm run dev
```

- [ ] **Step 2: Test fresh install flow**

Clear localStorage in browser and delete all user-created spaces. Verify:
- Onboarding banner appears on surface
- Click "Import from AI" → wizard opens
- Provider selector works, prompt loads
- Prompt contains no existing spaces (fresh mode)

- [ ] **Step 3: Test import flow**

Copy the prompt, paste into ChatGPT/Claude. Paste the response back:
- Preview shows plan with checkboxes, counts, warnings
- Untick a space → children auto-untick
- Click "Import selected" → spaces, project summaries, space overviews, memories created
- Post-import: switches to first new space

- [ ] **Step 4: Test re-import dedup**

Run the import again with the same data:
- Prompt now includes existing spaces (augment mode)
- Preview shows duplicates as `duplicate_skipped`
- Approve → no new items created

- [ ] **Step 5: Test error handling**

Paste invalid JSON:
- Regex cleanup strips fences
- If still broken, shows error inline
- Server doesn't crash

- [ ] **Step 6: Final commit**

```bash
git commit -m "feat(import): cloud AI import complete (#107)"
```

---

Plan complete and saved to `docs/superpowers/plans/2026-04-14-cloud-ai-import.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
