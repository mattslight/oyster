import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fal } from "@fal-ai/client";
import type { IconStatus } from "../../shared/types.js";

interface IconJob {
  artifactId: string;
  name: string;
  type: string;
  artifactDir: string;
  hint?: string;
}

type ArtifactUpdater = (
  id: string,
  fields: { icon?: string; iconStatus?: IconStatus }
) => void;

export class IconGenerator {
  private queue: IconJob[] = [];
  private processing = false;
  private enabled = false;
  private openaiKey: string | undefined;
  private updateArtifact: ArtifactUpdater;

  constructor(updateArtifact: ArtifactUpdater) {
    this.updateArtifact = updateArtifact;

    const falKey = process.env.FAL_KEY;
    if (!falKey) {
      console.log("[icon-generator] FAL_KEY not set — icon generation disabled");
      return;
    }

    fal.config({ credentials: falKey });
    this.openaiKey = process.env.OPENAI_API_KEY;
    this.enabled = true;

    if (this.openaiKey) {
      console.log("[icon-generator] ready (with LLM art direction)");
    } else {
      console.log("[icon-generator] ready (no OPENAI_API_KEY — using basic prompts)");
    }
  }

  enqueue(artifactId: string, name: string, type: string, artifactDir: string): void {
    if (!this.enabled) return;
    if (existsSync(join(artifactDir, "icon.png"))) return;
    if (this.queue.some((j) => j.artifactId === artifactId)) return;

    this.queue.push({ artifactId, name, type, artifactDir });
    this.updateArtifact(artifactId, { iconStatus: "pending" });

    if (!this.processing) {
      this.processQueue();
    }
  }

  // Force-regenerate an icon, deleting any existing one. Optional hint guides composition only.
  forceEnqueue(artifactId: string, name: string, type: string, artifactDir: string, hint?: string): boolean {
    if (!this.enabled) return false;

    // Remove existing icon so it gets replaced
    const iconPath = join(artifactDir, "icon.png");
    if (existsSync(iconPath)) {
      try { unlinkSync(iconPath); } catch {}
    }

    // Remove any pending job for this artifact and re-add with hint
    const idx = this.queue.findIndex((j) => j.artifactId === artifactId);
    if (idx !== -1) this.queue.splice(idx, 1);

    this.queue.push({ artifactId, name, type, artifactDir, hint });
    this.updateArtifact(artifactId, { iconStatus: "pending" });

    if (!this.processing) {
      this.processQueue();
    }
    return true;
  }

  private async processQueue(): Promise<void> {
    this.processing = true;

    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      try {
        await this.generateIcon(job);
      } catch (err) {
        console.error(`[icon-generator] failed for "${job.name}":`, err);
        this.updateArtifact(job.artifactId, { iconStatus: "failed" });
      }
    }

    this.processing = false;
  }

  private async generateIcon(job: IconJob): Promise<void> {
    console.log(`[icon-generator] generating icon for "${job.name}"...`);
    this.updateArtifact(job.artifactId, { iconStatus: "generating" });

    // Step 1: Read the app's source to understand what it actually is
    const sourceContent = readAppSource(job.artifactDir);

    // Step 2: Get an art-directed prompt from the LLM (or fall back to basic)
    let prompt: string;
    if (this.openaiKey && sourceContent) {
      prompt = await this.craftPromptWithLLM(job.name, job.type, sourceContent, job.hint);
      console.log(`[icon-generator] art-directed prompt: ${prompt.slice(0, 80)}...`);
    } else {
      prompt = buildBasicPrompt(job.name, job.type, job.hint);
    }

    // Step 3: Generate the icon with Flux
    const result = await fal.subscribe("fal-ai/flux/schnell", {
      input: {
        prompt,
        image_size: { width: 512, height: 512 },
        num_images: 1,
        num_inference_steps: 4,
        enable_safety_checker: true,
      },
    });

    const imageUrl = (result.data as { images: { url: string }[] }).images?.[0]?.url;
    if (!imageUrl) {
      throw new Error("No image URL in response");
    }

    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) {
      throw new Error(`Failed to download image: ${imageRes.status}`);
    }
    const buffer = Buffer.from(await imageRes.arrayBuffer());

    const iconPath = join(job.artifactDir, "icon.png");
    writeFileSync(iconPath, buffer);

    const dirName = job.artifactDir.split("/").pop();
    const servePath = `/artifacts/${dirName}/icon.png`;

    this.updateArtifact(job.artifactId, {
      icon: servePath,
      iconStatus: "ready",
    });

    console.log(`[icon-generator] saved icon for "${job.name}" → ${servePath}`);
  }

  private async craftPromptWithLLM(name: string, type: string, source: string, hint?: string): Promise<string> {
    // Truncate source to avoid huge token costs — first 3000 chars is enough context
    const truncated = source.slice(0, 3000);

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 200,
        messages: [
          {
            role: "system",
            content: `You write Flux image generation prompts. Given a software project's name, type, source code, and colour palette, write a prompt for a geometric illustration representing it.

CRITICAL RULES:
- NEVER use the word "icon" or "app icon" anywhere in your prompt — this causes unwanted rounded corners
- The image is a flat square — gradient fills every pixel to every edge, no borders, no frames, no rounded shapes around the edge
- No text, letters, numbers, or words anywhere

STYLE — GEOMETRIC / LOW-POLY:
- Flat geometric art with clean angles and hard edges
- ONE recognisable geometric object that represents what the software does (a snake game → a geometric snake, a weather tool → a geometric sun with angular rays)
- Object built from simple polygonal shapes: triangles, hexagons, angular facets — like a low-poly 3D render
- Limited colour count: use only the provided accent colour plus 1-2 lighter/darker shades for the object
- Background: smooth diagonal gradient using the two provided hex colours, filling the entire square edge to edge
- Object sits centred with clean negative space around it
- No outlines, no strokes — solid filled shapes only

Your prompt MUST:
- Start with: Geometric digital art.
- Specify the exact background gradient hex colours
- Describe one specific geometric/low-poly object using the accent colour
- Include: "No text, no letters, no words, no borders, no frames"
- End with: "Flat geometric shapes, clean angles, minimal palette, square canvas filled edge to edge."

Keep it to 2-3 sentences. Read the source code to pick an object SPECIFIC to what this software does.`,
          },
          {
            role: "user",
            content: `App name: "${name}"\nType: ${type}\n\nPalette — background gradient: ${(typePalette[type] || typePalette.app).gradientFrom} → ${(typePalette[type] || typePalette.app).gradientTo}, accent colour: ${(typePalette[type] || typePalette.app).accent}. Use these exact colours.${hint ? `\n\nComposition note (depict this, keep the geometric style): ${hint}` : ""}\n\nSource code:\n${truncated}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      console.warn(`[icon-generator] LLM failed (${res.status}), falling back to basic prompt`);
      return buildBasicPrompt(name, type);
    }

    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    const content = data.choices?.[0]?.message?.content?.trim();

    if (!content) {
      return buildBasicPrompt(name, type);
    }

    return content;
  }
}

const typePalette: Record<string, { accent: string; gradientFrom: string; gradientTo: string }> = {
  wireframe: { accent: "#818cf8", gradientFrom: "#2d2f52", gradientTo: "#353764" },
  deck:      { accent: "#a78bfa", gradientFrom: "#2d2f52", gradientTo: "#353764" },
  map:       { accent: "#4ade80", gradientFrom: "#1e3a2f", gradientTo: "#243f34" },
  notes:     { accent: "#4ade80", gradientFrom: "#1e3a2f", gradientTo: "#243f34" },
  app:       { accent: "#60a5fa", gradientFrom: "#1e2d4a", gradientTo: "#253a5c" },
  diagram:   { accent: "#fbbf24", gradientFrom: "#3a2d1e", gradientTo: "#4a3a24" },
  table:     { accent: "#22d3ee", gradientFrom: "#1e3a3a", gradientTo: "#244a4a" },
};

/** Read the app's main source file to understand what it does */
function readAppSource(artifactDir: string): string | null {
  try {
    // Try src/ directory first, then root
    const dirs = [join(artifactDir, "src"), artifactDir];
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir);
      for (const f of files) {
        if (f.endsWith(".html") || f.endsWith(".md") || f.endsWith(".tsx") || f.endsWith(".jsx")) {
          return readFileSync(join(dir, f), "utf8");
        }
      }
    }
  } catch {}
  return null;
}

/** Fallback prompt when no LLM is available */
function buildBasicPrompt(name: string, type: string, hint?: string): string {
  const typeHints: Record<string, string> = {
    app: "a geometric code bracket symbol",
    deck: "a geometric presentation screen",
    diagram: "a geometric flowchart with connected angular nodes",
    map: "a geometric map pin built from triangular facets",
    notes: "a geometric notepad with angular page folds",
    table: "a geometric grid of rectangular cells",
    wireframe: "a geometric wireframe layout of angular panels",
  };

  const subject = hint
    ? `a geometric low-poly depiction of: ${hint}`
    : (typeHints[type] || "a geometric symbol representing the concept");
  const p = typePalette[type] || typePalette.app;

  return `Geometric digital art. Square canvas, diagonal gradient background from ${p.gradientFrom} to ${p.gradientTo} filling the entire surface edge to edge. Single centred ${subject} rendered in ${p.accent} with angular low-poly facets. No text, no letters, no words, no borders, no frames. Flat geometric shapes, clean angles, minimal palette, square canvas filled edge to edge.`;
}
