import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROJECT_MARKERS = [
  ".git", "package.json", "go.mod", "Cargo.toml",
  "pyproject.toml", "setup.py", "requirements.txt",
  "Gemfile", "pom.xml", "build.gradle", "Makefile",
];

export interface Candidate {
  name: string;
  path: string;
  markers: string[];
  framework?: string;
  subProjects?: string[];
}

export interface SuggestedSpace {
  name: string;
  folders: string[];
}

/**
 * Richer output shape used by the agent-facing onboarding flow. Adds:
 *  - `reason`: why these folders went together (shown to the user).
 *  - `ambiguous`: true when the grouping isn't confident — the user-facing
 *    agent should ask the user before applying.
 */
export interface RichSuggestedSpace extends SuggestedSpace {
  reason: string;
  ambiguous: boolean;
}

export interface FolderInfo {
  name: string;
  path: string;
  markers: string[];         // code-project markers found (.git, package.json, etc.)
  framework?: string;
  subProjects?: string[];    // populated for monorepos
  fileCount: number;         // capped at a sentinel for perf
  sampleExtensions: string[]; // top few file extensions, for non-code classification
  isEmpty: boolean;
}

const HIDDEN_OR_SYSTEM = new Set([
  "node_modules", "dist", "build", ".next", "out", "coverage",
  ".cache", ".venv", "venv", "env", "target", "__pycache__",
]);

/**
 * List every non-hidden, non-noise subfolder of `containerPath` with
 * enough metadata for an LLM to classify it (code project, design
 * dump, writing folder, noise, etc.).
 */
export function discoverAllSubfolders(containerPath: string): FolderInfo[] {
  const out: FolderInfo[] = [];
  let entries: string[];
  try { entries = readdirSync(containerPath); } catch { return out; }

  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    if (HIDDEN_OR_SYSTEM.has(entry)) continue;
    const sub = join(containerPath, entry);
    try {
      if (!statSync(sub).isDirectory()) continue;
    } catch { continue; }

    let subEntries: string[];
    try { subEntries = readdirSync(sub); } catch { continue; }
    const markers = PROJECT_MARKERS.filter(m => subEntries.includes(m));

    // Walk a shallow sample to count files + extensions (cap at 200 for perf)
    const extCounts = new Map<string, number>();
    let fileCount = 0;
    const cap = 200;
    const walk = (dir: string, depth: number) => {
      if (fileCount >= cap || depth > 2) return;
      let items: string[];
      try { items = readdirSync(dir); } catch { return; }
      for (const item of items) {
        if (fileCount >= cap) return;
        if (item.startsWith(".") || HIDDEN_OR_SYSTEM.has(item)) continue;
        const p = join(dir, item);
        let st: ReturnType<typeof statSync>;
        try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) {
          walk(p, depth + 1);
        } else {
          fileCount++;
          const dot = item.lastIndexOf(".");
          if (dot > 0) {
            const ext = item.slice(dot).toLowerCase();
            extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
          }
        }
      }
    };
    walk(sub, 0);

    const sampleExtensions = Array.from(extCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ext]) => ext);

    // Detect framework (best-effort, only for package.json candidates)
    let framework: string | undefined;
    if (markers.includes("package.json")) {
      try {
        const pkg = JSON.parse(readFileSync(join(sub, "package.json"), "utf8"));
        const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
        const frameworks = ["react", "vue", "next", "vite", "svelte", "angular", "nuxt", "astro"];
        framework = frameworks.find(f => deps.some(d => d.includes(f)));
      } catch { /* best effort */ }
    } else if (markers.includes("go.mod")) framework = "go";
    else if (markers.includes("Cargo.toml")) framework = "rust";
    else if (markers.includes("pyproject.toml") || markers.includes("setup.py")) framework = "python";
    else if (markers.includes("Gemfile")) framework = "ruby";
    else if (markers.includes("pom.xml") || markers.includes("build.gradle")) framework = "java";

    out.push({
      name: entry,
      path: sub,
      markers,
      framework,
      fileCount,
      sampleExtensions,
      isEmpty: fileCount === 0,
    });
  }

  return out;
}

/**
 * Check if a dropped folder is a container of projects (like ~/Dev)
 * vs a single project (like ~/Dev/blunderfixer).
 */
export function isContainer(dirPath: string): boolean {
  let entries: string[];
  try { entries = readdirSync(dirPath); } catch { return false; }

  const hasOwnMarkers = PROJECT_MARKERS.some(m => entries.includes(m));
  if (hasOwnMarkers) return false;

  let projectCount = 0;
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const sub = join(dirPath, entry);
    try {
      if (!statSync(sub).isDirectory()) continue;
    } catch { continue; }
    const subEntries = readdirSync(sub);
    if (PROJECT_MARKERS.some(m => subEntries.includes(m))) {
      projectCount++;
    }
  }

  return projectCount >= 2;
}

/**
 * Scan a container folder and return candidate projects.
 */
export function discoverCandidates(containerPath: string): Candidate[] {
  const candidates: Candidate[] = [];
  let entries: string[];
  try { entries = readdirSync(containerPath); } catch { return []; }

  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const sub = join(containerPath, entry);
    try {
      if (!statSync(sub).isDirectory()) continue;
    } catch { continue; }

    const subEntries = readdirSync(sub);
    const markers = PROJECT_MARKERS.filter(m => subEntries.includes(m));
    if (markers.length === 0) continue;

    let framework: string | undefined;
    if (subEntries.includes("package.json")) {
      try {
        const pkg = JSON.parse(readFileSync(join(sub, "package.json"), "utf8"));
        const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
        const frameworks = ["react", "vue", "next", "vite", "svelte", "angular", "nuxt", "astro"];
        framework = frameworks.find(f => deps.some(d => d.includes(f)));
      } catch {}
    } else if (markers.includes("go.mod")) {
      framework = "go";
    } else if (markers.includes("Cargo.toml")) {
      framework = "rust";
    } else if (markers.includes("pyproject.toml") || markers.includes("setup.py")) {
      framework = "python";
    } else if (markers.includes("Gemfile")) {
      framework = "ruby";
    } else if (markers.includes("pom.xml") || markers.includes("build.gradle")) {
      framework = "java";
    }

    // Detect monorepo — sub-dirs (depth 1-2) with their own project markers
    const subProjects: string[] = [];
    const WORKSPACE_DIRS = new Set(["apps", "packages", "services", "libs", "modules", "tools"]);
    for (const subEntry of subEntries) {
      if (subEntry.startsWith(".") || subEntry === "node_modules" || subEntry === "dist" || subEntry === "build") continue;
      const subSub = join(sub, subEntry);
      try {
        if (!statSync(subSub).isDirectory()) continue;
        const subSubEntries = readdirSync(subSub);
        if (PROJECT_MARKERS.some(m => subSubEntries.includes(m))) {
          subProjects.push(subEntry);
        }
        // Check one level deeper for workspace patterns (apps/web, packages/shared)
        if (WORKSPACE_DIRS.has(subEntry)) {
          for (const nested of subSubEntries) {
            const nestedPath = join(subSub, nested);
            try {
              if (!statSync(nestedPath).isDirectory()) continue;
              const nestedEntries = readdirSync(nestedPath);
              if (PROJECT_MARKERS.some(m => nestedEntries.includes(m))) {
                subProjects.push(`${subEntry}/${nested}`);
              }
            } catch { continue; }
          }
        }
      } catch { continue; }
    }

    // Also flag pnpm/yarn/lerna workspaces as monorepos even if sub-project scan missed them
    const isWorkspace = subEntries.includes("pnpm-workspace.yaml") || subEntries.includes("lerna.json");
    const hasSubProjects = subProjects.length > 0 || isWorkspace;

    candidates.push({ name: entry, path: sub, markers, framework, subProjects: hasSubProjects ? (subProjects.length > 0 ? subProjects : ["(workspace)"]) : undefined });
  }

  return candidates;
}

// ── LLM provider abstraction ──

interface AuthConfig {
  provider: string;
  key: string;
}

// Provider → { baseUrl, model } for OpenAI-compatible APIs
const OPENAI_COMPAT: Record<string, { baseUrl: string; model: string }> = {
  openai:     { baseUrl: "https://api.openai.com/v1",               model: "gpt-4o-mini" },
  perplexity: { baseUrl: "https://api.perplexity.ai",               model: "sonar" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1",            model: "anthropic/claude-haiku-4-5-20251001" },
  groq:       { baseUrl: "https://api.groq.com/openai/v1",          model: "llama-3.3-70b-versatile" },
  copilot:    { baseUrl: "https://api.githubcopilot.com",            model: "gpt-4o-mini" },
  together:   { baseUrl: "https://api.together.xyz/v1",              model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
};

function readAuth(): AuthConfig | null {
  const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");

  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf8"));
      // Check all providers in auth.json — use the first one with a key
      for (const [provider, creds] of Object.entries(auth)) {
        const c = creds as Record<string, string>;
        const key = c.key ?? c.access;
        if (key) return { provider, key };
      }
    } catch {}
  }

  // Fall back to env vars
  if (process.env.ANTHROPIC_API_KEY) return { provider: "anthropic", key: process.env.ANTHROPIC_API_KEY };
  if (process.env.OPENAI_API_KEY) return { provider: "openai", key: process.env.OPENAI_API_KEY };
  if (process.env.GEMINI_API_KEY) return { provider: "google", key: process.env.GEMINI_API_KEY };
  if (process.env.PERPLEXITY_API_KEY) return { provider: "perplexity", key: process.env.PERPLEXITY_API_KEY };
  if (process.env.GROQ_API_KEY) return { provider: "groq", key: process.env.GROQ_API_KEY };

  return null;
}

async function callLLM(auth: AuthConfig, prompt: string): Promise<string | null> {
  try {
    // Anthropic has a different API format
    if (auth.provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": auth.key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) return null;
      const data = await res.json() as { content: Array<{ text: string }> };
      return data.content[0]?.text ?? null;
    }

    // Google has its own format
    if (auth.provider === "google") {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${auth.key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
          }),
        },
      );
      if (!res.ok) return null;
      const data = await res.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    }

    // Everything else: OpenAI-compatible (OpenAI, Perplexity, Groq, OpenRouter, etc.)
    const compat = OPENAI_COMPAT[auth.provider];
    if (!compat) return null; // handled by callViaOpenCode fallback
    const res = await fetch(`${compat.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${auth.key}`,
      },
      body: JSON.stringify({
        model: compat.model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content ?? null;

  } catch (err) {
    console.log(`[discovery] LLM call error: ${err}`);
  }

  return null;
}

/**
 * Fallback: send prompt through the running OpenCode instance.
 * Works with any provider the user authenticated with.
 */
async function callViaOpenCode(prompt: string, port = 4096): Promise<string | null> {
  try {
    // Create a throwaway session
    const sessionRes = await fetch(`http://127.0.0.1:${port}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!sessionRes.ok) return null;
    const session = await sessionRes.json() as { id: string };

    // Send the message
    const msgRes = await fetch(`http://127.0.0.1:${port}/session/${session.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
    });
    if (!msgRes.ok) return null;
    const msg = await msgRes.json() as { parts: Array<{ type: string; text?: string }> };

    // Extract text from response parts
    return msg.parts?.filter(p => p.type === "text").map(p => p.text).join("") ?? null;
  } catch (err) {
    console.log(`[discovery] OpenCode fallback error: ${err}`);
    return null;
  }
}

/**
 * Call LLM to group candidates into suggested spaces.
 * Uses whatever provider the user authenticated with via OpenCode.
 */
export async function groupWithLLM(candidates: Candidate[]): Promise<SuggestedSpace[]> {
  const auth = readAuth();
  if (!auth) {
    console.log("[discovery] No auth found, using fallback grouping");
    return fallbackGrouping(candidates);
  }

  console.log(`[discovery] Using ${auth.provider} for grouping`);

  const candidateList = candidates.map(c => {
    let desc = c.name;
    if (c.framework) desc += ` (${c.framework})`;
    if (c.subProjects?.length) desc += ` [monorepo: ${c.subProjects.join(", ")}]`;
    return desc;
  });

  const prompt = `You are organising a developer's workspace. Given these project folders found in their dev directory, group them into logical spaces.

Project folders:
${candidateList.map(c => `- ${c}`).join("\n")}

Rules:
- Related repos (same product/project) should be grouped into one space
- Look for naming patterns: shared prefixes, suffixes like -api, -web, -portal, -docs
- Monorepos (marked with [monorepo:]) are already self-contained — they should get their own space, not go in "other"
- Projects that look like real products or apps should get their own space
- Only put genuinely miscellaneous things (tiny configs, forks, one-off scripts) in "other"
- Use clean, lowercase names for spaces (e.g. "tokinvest" not "tokinvest-drc")
- Every folder must appear in exactly one space

Return ONLY valid JSON, no markdown, no explanation:
[{"name": "Space Name", "folders": ["folder1", "folder2"]}, ...]`;

  let text = await callLLM(auth, prompt);

  // If direct API call failed, try via OpenCode (handles any provider)
  if (!text) {
    console.log("[discovery] Direct LLM call failed, trying via OpenCode");
    text = await callViaOpenCode(prompt);
  }

  if (!text) {
    console.log("[discovery] All LLM attempts failed, using fallback");
    return fallbackGrouping(candidates);
  }

  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return fallbackGrouping(candidates);

    const groups = JSON.parse(jsonMatch[0]) as SuggestedSpace[];

    // Map folder names back to full paths
    return groups.map(g => ({
      name: g.name,
      folders: g.folders.map(f => {
        const candidate = candidates.find(c => c.name === f);
        return candidate?.path ?? f;
      }),
    }));
  } catch {
    console.log("[discovery] Failed to parse LLM response, using fallback");
    return fallbackGrouping(candidates);
  }
}

/**
 * Simple fallback: each candidate becomes its own space.
 */
function fallbackGrouping(candidates: Candidate[]): SuggestedSpace[] {
  return candidates.map(c => ({
    name: c.name.replace(/[-_]/g, " "),
    folders: [c.path],
  }));
}

// ── Rich classification (non-code-biased) ──
//
// Operates on the full subfolder list (not just marker-matched) so users
// whose work isn't all code — designers, writers, PMs — get decent
// grouping too. The LLM classifies each folder (project / noise / unclear),
// groups related ones, and writes a reason per group.

function folderSummary(f: FolderInfo): string {
  const markers = f.markers.length > 0 ? `markers: ${f.markers.join(", ")}` : "no markers";
  const fw = f.framework ? `; ${f.framework}` : "";
  const exts = f.sampleExtensions.length > 0 ? `; exts ${f.sampleExtensions.join(" ")}` : "";
  const count = f.isEmpty ? "empty" : `${f.fileCount}${f.fileCount >= 200 ? "+" : ""} files`;
  return `${f.name} (${markers}${fw}; ${count}${exts})`;
}

function fallbackRichGrouping(folders: FolderInfo[]): RichSuggestedSpace[] {
  // No LLM available: treat anything with markers as a project, skip the rest,
  // and give a basic reason. Non-code folders are returned as "other" so the
  // agent has *something* to show the user.
  const projects = folders.filter(f => f.markers.length > 0 && !f.isEmpty);
  const nonCode = folders.filter(f => f.markers.length === 0 && !f.isEmpty);
  const out: RichSuggestedSpace[] = projects.map(p => ({
    name: p.name.replace(/[-_]/g, " "),
    folders: [p.path],
    reason: `Has ${p.markers.slice(0, 2).join(", ")}${p.framework ? ` (${p.framework})` : ""}.`,
    ambiguous: false,
  }));
  if (nonCode.length > 0) {
    out.push({
      name: "other",
      folders: nonCode.map(f => f.path),
      reason: "No code markers; grouped as misc so the user can sort them.",
      ambiguous: true,
    });
  }
  return out;
}

/**
 * Rich grouping: classify + group every non-noise subfolder via the LLM.
 * Returns grouped spaces with a per-group reason and an `ambiguous` flag.
 */
export async function groupWithLLMRich(folders: FolderInfo[]): Promise<RichSuggestedSpace[]> {
  const auth = readAuth();
  if (!auth) {
    console.log("[discovery] No auth found, using rich fallback");
    return fallbackRichGrouping(folders);
  }

  console.log(`[discovery] Using ${auth.provider} for rich grouping (${folders.length} folders)`);

  const lines = folders.map(folderSummary);

  const prompt = `You are organising a user's workspace. The user may be a developer, designer, writer, PM, researcher, or mixed. Below is every non-hidden subfolder in their projects directory, with metadata.

CRITICAL: EVERY folder listed below MUST appear exactly once in your output. Silent omissions cause real projects to disappear from the user's workspace.

Folders:
${lines.map(l => `- ${l}`).join("\n")}

Rules:
- Group related projects into one space. Signals: shared prefix or suffix (e.g. oyster-* → one "oyster" space; tokinvest-drc + tokinvest-website → "tokinvest"), monorepos, same framework serving a single product.
- Isolated third-party libraries / forks (e.g. "graphiti", "stockfish") that the user is not developing themselves belong in "other", not their own space.
- Tiny config-only folders (single .conf / .nanorc / similar) belong in "other".
- Non-code folders (.md notes, .fig design, .docx writing) are first-class projects if they're actively used.
- System/noise folders (git worktree scratch directories, cache dumps, truly empty folders, temp dirs) go in a group named "skipped" with a one-sentence reason. They are NOT omitted — they are moved to "skipped" so the user has a complete audit trail.
- Space names: short, lowercase, human (e.g. "oyster", "tokinvest", "writing", "design", not "oyster-technology-www").
- For every group include a one-sentence reason citing the evidence (shared prefix, dominant extensions, framework, why it's noise, etc.).
- Set "ambiguous": true when the grouping is a guess (e.g. a single loose folder the user might want elsewhere). For "skipped" noise, set ambiguous: false if it's clearly noise, true if you're unsure.

Return ONLY valid JSON, no markdown, no explanation:
[
  {"name": "oyster", "folders": ["oyster-os", "oyster-crm", "oyster-technology"], "reason": "Three repos share the 'oyster-' prefix and reference the same product.", "ambiguous": false},
  {"name": "other", "folders": ["graphiti", "nanorc"], "reason": "Third-party library and single-file config — not user-owned projects.", "ambiguous": true},
  {"name": "skipped", "folders": ["repo.worktrees"], "reason": "Git worktree scratch — not a project.", "ambiguous": false}
]`;

  let text = await callLLM(auth, prompt);
  if (!text) {
    console.log("[discovery] Direct LLM call failed, trying via OpenCode");
    text = await callViaOpenCode(prompt);
  }
  if (!text) {
    console.log("[discovery] All LLM attempts failed, using rich fallback");
    return fallbackRichGrouping(folders);
  }

  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return fallbackRichGrouping(folders);
    const raw = JSON.parse(jsonMatch[0]) as Array<{ name: string; folders: string[]; reason?: string; ambiguous?: boolean }>;

    const byName = new Map(folders.map(f => [f.name, f.path]));
    const inputNames = new Set(folders.map(f => f.name));

    // Parse LLM output, remap names → paths
    const parsed: RichSuggestedSpace[] = raw
      .map(g => ({
        name: g.name,
        folders: (g.folders ?? []).filter(f => byName.has(f)),
        reason: g.reason ?? "",
        ambiguous: Boolean(g.ambiguous),
      }))
      .filter(g => g.folders.length > 0);

    // Audit: every input folder MUST appear in output. If the LLM dropped
    // anything (silent omission, despite the prompt), recover it into a
    // `review` group so the user / agent still sees it.
    const covered = new Set<string>();
    for (const g of parsed) for (const f of g.folders) covered.add(f);
    const missing = [...inputNames].filter(n => !covered.has(n));
    if (missing.length > 0) {
      console.warn(`[discovery] LLM dropped ${missing.length} folder(s), recovering: ${missing.join(", ")}`);
      parsed.push({
        name: "review",
        folders: missing,
        reason: "The classifier omitted these folders — they might be real projects or noise. Please review.",
        ambiguous: true,
      });
    }

    // Map names → paths for final output
    return parsed.map(g => ({
      ...g,
      folders: g.folders.map(n => byName.get(n) ?? n),
    }));
  } catch (err) {
    console.log(`[discovery] Failed to parse rich LLM response: ${(err as Error).message}`);
    return fallbackRichGrouping(folders);
  }
}
