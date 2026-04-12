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
}

export interface SuggestedSpace {
  name: string;
  folders: string[];
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

    candidates.push({ name: entry, path: sub, markers, framework });
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
    return desc;
  });

  const prompt = `You are organising a developer's workspace. Given these project folder names found in their dev directory, group them into logical workspaces/spaces.

Project folders:
${candidateList.map(c => `- ${c}`).join("\n")}

Rules:
- Related repos (same product/project) should be grouped into one space
- Look for naming patterns: shared prefixes, suffixes like -api, -web, -portal, -docs
- Standalone projects that look like real products/apps get their own space
- Small utilities, configs, forks, or miscellaneous repos should go in a catch-all space called "other"
- Use clean, lowercase names for spaces (e.g. "tokinvest" not "tokinvest-drc" or "Tokinvest")
- Every folder must appear in exactly one space
- Aim for fewer spaces rather than more — group aggressively

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
