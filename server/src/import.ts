import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
  knownProjects: Map<string, string[]>;
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

// ── JSON Parsing & Recovery ──

function stripMarkdownFences(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }
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
  const cleaned = stripMarkdownFences(raw);

  try {
    const parsed = JSON.parse(cleaned);
    return { success: true, payload: parsed as ImportPayload };
  } catch (e1) {
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

    return {
      success: false,
      error: `Invalid JSON: ${(e1 as Error).message}`,
    };
  }
}

// ── Preview (Plan Building) ──

export interface PreviewDeps {
  getSpaceBySlug: (slug: string) => { id: string; displayName: string } | null;
  getArtifactsBySpace: (spaceId: string) => Array<{ source_ref: string | null; label: string }>;
  findMemory: (content: string, spaceId: string | null) => boolean;
}

function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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

  const spaceActionIds = new Map<string, string>();

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

    for (const project of space.projects ?? []) {
      if (!project.name) continue;
      const spaceId = existing?.id ?? slug;
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
  const createdSpaces = new Map<string, string>();

  // Validate: reject orphaned actions
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

  const ordered = plan.actions.filter((a) => approved.has(a.action_id));

  for (const action of ordered) {
    try {
      switch (action.type) {
        case "create_space": {
          if (action.status === "exists_will_merge") {
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
