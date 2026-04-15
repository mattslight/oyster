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
  target_space_id?: string;
  counts: { new: number; merge: number; skipped: number };
  warnings: string[];
  actions: ImportAction[];
}

export interface ExecuteResult {
  results: Array<{ action_id: string; status: "created" | "skipped" | "failed"; error?: string }>;
  counts: { created: number; failed: number };
}

// ── Plan Store (in-memory, TTL 30 min) ──

const plans = new Map<string, { plan: ImportPlan; payload: ImportPayload; expires: number }>();
const PLAN_TTL = 30 * 60 * 1000;

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

let importStatePath = join(homedir(), ".oyster", "import-state.json");

export function setImportStatePath(userlandDir: string): void {
  importStatePath = join(userlandDir, "import-state.json");
}

interface ImportState {
  [provider: string]: { last_import_date: string };
}

function readImportState(): ImportState {
  try {
    if (existsSync(importStatePath)) {
      return JSON.parse(readFileSync(importStatePath, "utf8"));
    }
  } catch {}
  return {};
}

export function writeImportDate(provider: string): void {
  const state = readImportState();
  state[provider] = { last_import_date: new Date().toISOString() };
  writeFileSync(importStatePath, JSON.stringify(state, null, 2) + "\n");
}

// ── Prompt Generation ──

const SCHEMA_EXAMPLE = `schema_version: 1
mode: fresh
source:
  provider: chatgpt
  generated_at: "2026-04-14T18:00:00Z"
spaces:
  - name: Work
    projects:
      - name: Project Name
        summary: One sentence about this project.
summaries:
  - space: Work
    title: Work overview
    content: 2-3 sentences summarising this space.
memories:
  - content: A durable fact, preference, or constraint worth remembering.
    tags: [preference]
    space: Work`;

export interface PromptContext {
  provider: string;
  spaces: Array<{ id: string; displayName: string }>;
  knownProjects: Map<string, string[]>;
  targetSpace?: { id: string; displayName: string };
}

export function generatePrompt(ctx: PromptContext): string {
  // Space-scoped prompt — focused on one topic
  if (ctx.targetSpace) {
    const name = ctx.targetSpace.displayName;
    const projects = ctx.knownProjects.get(ctx.targetSpace.id) || [];
    let prompt = `Based on our past conversations, tell me everything you know about "${name}".\n\n`;
    if (projects.length > 0) {
      prompt += `I already have these projects tracked: ${projects.join(", ")}. Include any new ones.\n\n`;
    }
    prompt += `RULES:
- Include: projects, key decisions, preferences, recurring themes, important context.
- Exclude: one-off questions, ephemeral chat, anything not durable.
- Use ONLY this one space: "${name}". Do not create other spaces.
- Summaries: one for the space, 2-3 sentences.
- Memories: durable facts and preferences related to ${name}.

OUTPUT FORMAT:
- Output YAML only. No markdown fences. No prose before or after.
- Set mode to "augment".
- Set source.provider to "${ctx.provider}".
- Set source.generated_at to the current time in ISO 8601 format.

SCHEMA:
${SCHEMA_EXAMPLE}`;
    return prompt;
  }

  // Global prompt — all workstreams
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
- Output YAML only. No markdown fences. No prose before or after. No explanation.
- Set mode to "${mode}".
- Set source.provider to "${ctx.provider}".
- Set source.generated_at to the current time in ISO 8601 format.

SCHEMA:
${SCHEMA_EXAMPLE}`;

  return prompt;
}

// ── Parsing (YAML/JSON + AI fallback) ──

function stripFences(raw: string): string {
  let s = raw.trim().replace(/^\uFEFF/, "");
  s = s.replace(/^```(?:json|yaml|yml)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
  return s.trim();
}

export interface ParseResult {
  success: boolean;
  payload?: ImportPayload;
  error?: string;
  recovered?: boolean;
}

export async function parseImportPayload(
  raw: string,
  convertFn?: (text: string) => Promise<string | null>,
): Promise<ParseResult> {
  const cleaned = stripFences(raw);

  // Fast path: already valid JSON
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && (Array.isArray(parsed.spaces) || Array.isArray(parsed.summaries) || Array.isArray(parsed.memories))) {
      return { success: true, payload: parsed as ImportPayload };
    }
  } catch (err) {
    console.log("[import] JSON parse failed:", (err as Error).message);
  }

  // Convert through AI — the expected path for most real AI output
  if (convertFn) {
    try {
      console.log("[import] Sending to AI for conversion...");
      const converted = await convertFn(cleaned);
      if (converted) {
        console.log("[import] AI returned:", converted.slice(0, 200));
        const json = stripFences(converted);
        const parsed = JSON.parse(json);
        if (parsed && typeof parsed === "object" && (Array.isArray(parsed.spaces) || Array.isArray(parsed.summaries) || Array.isArray(parsed.memories))) {
          return { success: true, payload: parsed as ImportPayload };
        }
        console.log("[import] AI response parsed but spaces is not an array");
      } else {
        console.log("[import] AI conversion returned null");
      }
    } catch (err) {
      console.error("[import] AI conversion error:", err);
    }
  } else {
    console.log("[import] No convertFn provided");
  }

  return { success: false, error: "Could not parse the response. Try pasting the full output from your AI." };
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
  targetSpaceId?: string,
): ImportPlan {
  const planId = `imp_${randomUUID().slice(0, 12)}`;
  const actions: ImportAction[] = [];
  const warnings: string[] = [];
  let actCounter = 0;
  const nextId = () => `act_${++actCounter}`;

  // When scoped to a target space, resolve the display name for remapping
  const targetSpaceRow = targetSpaceId ? deps.getSpaceBySlug(targetSpaceId) : null;
  const targetSpaceName = targetSpaceRow?.displayName ?? targetSpaceId;

  const spaceActionIds = new Map<string, string>();

  for (const space of payload.spaces ?? []) {
    if (!space.name) continue;

    if (targetSpaceId) {
      // Space-scoped: skip create_space, remap projects into target
      for (const project of space.projects ?? []) {
        if (!project.name) continue;
        const existingArtifacts = deps.getArtifactsBySpace(targetSpaceId);
        const isDupe = existingArtifacts.some(
          (a) => a.source_ref?.startsWith("import:") && slugify(a.label) === slugify(project.name),
        );
        actions.push({
          action_id: nextId(),
          type: "create_project_summary",
          space: targetSpaceName!,
          name: project.name,
          summary: project.summary,
          status: isDupe ? "duplicate_skipped" : "new",
        });
      }
      continue;
    }

    const slug = slugify(space.name);
    if (!slug) continue;
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

    if (targetSpaceId) {
      const existingArtifacts = deps.getArtifactsBySpace(targetSpaceId);
      const hasOverview = existingArtifacts.some((a) => a.source_ref?.includes("overview"));
      actions.push({
        action_id: nextId(),
        type: "create_space_overview",
        space: targetSpaceName!,
        title: summary.title || `${targetSpaceName} overview`,
        content: summary.content,
        status: hasOverview ? "exists_will_merge" : "new",
      });
      continue;
    }

    const slug = slugify(summary.space);
    const existing = deps.getSpaceBySlug(slug);
    const parentActionId = spaceActionIds.get(summary.space);
    if (!existing && !parentActionId) continue;
    const spaceId = existing?.id ?? slug;
    const existingArtifacts = deps.getArtifactsBySpace(spaceId);
    const hasOverview = existingArtifacts.some(
      (a) => a.source_ref?.includes("overview"),
    );

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
    const spaceId = targetSpaceId ?? (memory.space ? (deps.getSpaceBySlug(slugify(memory.space))?.id ?? slugify(memory.space)) : null);
    const isDupe = deps.findMemory(memory.content, spaceId);

    actions.push({
      action_id: nextId(),
      type: "create_memory",
      content: memory.content,
      tags: memory.tags,
      space: targetSpaceName ?? memory.space,
      status: isDupe ? "duplicate_skipped" : "new",
    });
  }

  const counts = {
    new: actions.filter((a) => a.status === "new").length,
    merge: actions.filter((a) => a.status === "exists_will_merge").length,
    skipped: actions.filter((a) => a.status === "duplicate_skipped").length,
  };

  const plan: ImportPlan = { plan_id: planId, provider, generated_at: generatedAt, target_space_id: targetSpaceId, counts, warnings, actions };
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
  findMemory: (content: string, spaceId: string | null) => boolean;
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

  // When scoped to a target space, all space references resolve to it
  if (plan.target_space_id) {
    for (const action of plan.actions) {
      if (action.space) createdSpaces.set(action.space, plan.target_space_id);
    }
  }

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
          // Check if already exists before creating
          if (deps.findMemory && deps.findMemory(action.content!, spaceId ?? null)) {
            results.push({ action_id: action.action_id, status: "skipped" });
          } else {
            const importTag = `_import:${plan.provider}:${plan.generated_at.slice(0, 10)}`;
            const tags = [...(action.tags || []), importTag];
            await deps.remember({
              content: action.content!,
              space_id: spaceId,
              tags,
            });
            results.push({ action_id: action.action_id, status: "created" });
          }
          break;
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("already exists")) {
        results.push({ action_id: action.action_id, status: "skipped" });
      } else {
        results.push({ action_id: action.action_id, status: "failed", error: msg });
      }
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
