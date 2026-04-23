import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { homedir } from "node:os";
import crypto from "node:crypto";
import type { SpaceStore, SpaceRow } from "./space-store.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { Space, ScanResult } from "../../shared/types.js";
import { slugify, toScanStatus } from "./utils.js";

const SPACE_PALETTE = [
  "#6057c4", "#3d8aaa", "#3a8f64", "#b06840",
  "#8f5a9e", "#3a8a7a", "#9e7c2a", "#8f4a5a",
];

function hashStr(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

function rowToSpace(row: SpaceRow): Space {
  // ai_job_status / ai_job_error are Phase 2 scaffolding — intentionally not exposed to clients yet
  return {
    id: row.id,
    displayName: row.display_name,
    color: row.color,
    parentId: row.parent_id,
    scanStatus: toScanStatus(row.scan_status),
    scanError: row.scan_error,
    lastScannedAt: row.last_scanned_at,
    lastScanSummary: row.last_scan_summary ? JSON.parse(row.last_scan_summary) : null,
    summaryTitle: row.summary_title,
    summaryContent: row.summary_content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".cache", ".claude", ".opencode", ".vscode", ".idea", "__pycache__", ".tox", "venv", ".venv", "target", "vendor"]);
const SKIP_FILE_PATTERNS = [/\.lock$/, /\.log$/];
const MAX_DEPTH = 4;
const APP_DIR_NAMES = new Set(["web", "admin", "app", "client", "frontend", "ui", "dashboard", "portal", "site"]);
const APP_DEP_KEYWORDS = ["react", "vue", "next", "vite", "svelte", "angular", "nuxt", "astro", "remix", "solid"];
const PROJECT_MARKERS = ["go.mod", "Cargo.toml", "pyproject.toml", "setup.py", "requirements.txt", "Gemfile", "pom.xml", "build.gradle"];

export class SpaceService {
  private scanning = new Set<string>();

  constructor(
    private spaceStore: SpaceStore,
    private artifactStore: ArtifactStore,
  ) {}

  createSpace(params: { name: string }): Space {
    const displayName = params.name.trim();
    if (!displayName) throw new Error("name must not be empty");
    const id = slugify(displayName);
    if (!id) throw new Error("name must contain at least one alphanumeric character");
    if (this.spaceStore.getById(id)) throw new Error(`Space "${id}" already exists`);

    const color = SPACE_PALETTE[hashStr(id) % SPACE_PALETTE.length];
    this.spaceStore.insert({
      id, display_name: displayName, color, parent_id: null,
      scan_status: "none", scan_error: null, last_scanned_at: null,
      last_scan_summary: null, ai_job_status: null, ai_job_error: null,
      summary_title: null, summary_content: null,
    });

    return rowToSpace(this.spaceStore.getById(id)!);
  }

  addPath(spaceId: string, rawPath: string): string {
    const row = this.spaceStore.getById(spaceId);
    if (!row) throw new Error(`Space "${spaceId}" not found`);

    const resolved = rawPath.startsWith("~/")
      ? resolve(join(homedir(), rawPath.slice(2)))
      : resolve(rawPath);

    if (!existsSync(resolved)) throw new Error(`Path does not exist: ${resolved}`);
    if (!statSync(resolved).isDirectory()) throw new Error(`Path is not a directory: ${resolved}`);

    // Check if this path is already attached to another space
    const existing = this.spaceStore.getSpaceByPath(resolved);
    if (existing && existing.id !== spaceId) {
      throw new Error(`Path is already attached to space "${existing.display_name}"`);
    }

    this.spaceStore.addPath(spaceId, resolved);
    return resolved;
  }

  removePath(spaceId: string, path: string): void {
    this.spaceStore.removePath(spaceId, path);
  }

  getPaths(spaceId: string): string[] {
    return this.spaceStore.getPaths(spaceId).map(p => p.path);
  }

  listSpaces(): Space[] { return this.spaceStore.getAll().map(rowToSpace); }
  getSpace(id: string): Space | null {
    const row = this.spaceStore.getById(id);
    return row ? rowToSpace(row) : null;
  }
  setSummary(id: string, title: string, content: string): Space {
    const row = this.spaceStore.getById(id);
    if (!row) throw new Error(`Space "${id}" not found`);
    this.spaceStore.update(id, { summary_title: title, summary_content: content });
    return rowToSpace(this.spaceStore.getById(id)!);
  }

  updateSpace(id: string, fields: { displayName?: string; color?: string }): Space {
    const row = this.spaceStore.getById(id);
    if (!row) throw new Error(`Space "${id}" not found`);
    const dbFields: Record<string, string> = {};
    if (fields.displayName !== undefined) {
      const trimmed = fields.displayName.trim();
      if (!trimmed) throw new Error("displayName must not be empty");
      dbFields.display_name = trimmed;
    }
    if (fields.color !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(fields.color)) throw new Error("color must be a 6-digit hex string");
      dbFields.color = fields.color;
    }
    this.spaceStore.update(id, dbFields);
    return rowToSpace(this.spaceStore.getById(id)!);
  }

  convertFolderToSpace(sourceSpaceId: string, folderName: string, targetSpaceId: string): void {
    const artifacts = this.artifactStore.getBySpaceId(sourceSpaceId)
      .filter(a => a.group_name === folderName);
    for (const a of artifacts) {
      this.artifactStore.update(a.id, { space_id: targetSpaceId, group_name: null });
    }
  }

  deleteSpace(id: string, folderNameOverride?: string): void {
    if (id === "home" || id === "__all__") throw new Error(`Cannot delete reserved space "${id}"`);
    const row = this.spaceStore.getById(id);
    if (!row) throw new Error(`Space "${id}" not found`);
    const folderName = folderNameOverride ?? row?.display_name ?? id;
    const artifacts = this.artifactStore.getBySpaceId(id);
    // Move orphaned artifacts to home in a folder named after the deleted space
    for (const a of artifacts) {
      this.artifactStore.update(a.id, { space_id: "home", group_name: folderName });
    }
    this.spaceStore.delete(id);
  }

  async scanSpace(spaceId: string): Promise<ScanResult> {
    const row = this.spaceStore.getById(spaceId);
    if (!row) throw new Error(`Space "${spaceId}" not found`);

    const paths = this.spaceStore.getPaths(spaceId).map(p => p.path);
    if (paths.length === 0) throw new Error(`Space "${spaceId}" has no folders`);

    if (this.scanning.has(spaceId)) throw new Error(`Scan already in progress for space "${spaceId}"`);

    this.scanning.add(spaceId);
    this.spaceStore.update(spaceId, { scan_status: "scanning", scan_error: null });

    const result: ScanResult = { discovered: 0, skipped: 0, resurfaced: 0, errors: [], artifacts: [] };
    try {
      for (const folderPath of paths) {
        if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
          result.errors.push(`Skipped missing folder: ${folderPath}`);
          continue;
        }
        const folderSlug = folderPath.split(sep).pop() ?? folderPath;
        const candidates = this.walk(folderPath);
        for (const c of candidates) {
          // Namespace sourceRef with folder name to avoid collisions across multiple paths
          c.sourceRef = `${folderSlug}/${c.sourceRef}`;
          this.upsertCandidate(spaceId, c, result);
        }
      }
      this.spaceStore.update(spaceId, {
        scan_status: "complete",
        last_scanned_at: new Date().toISOString(),
        last_scan_summary: JSON.stringify({
          discovered: result.discovered, skipped: result.skipped,
          resurfaced: result.resurfaced, errors: result.errors,
        }),
      });
    } catch (err) {
      this.spaceStore.update(spaceId, { scan_status: "error", scan_error: (err as Error).message });
      throw err;
    } finally {
      this.scanning.delete(spaceId);
    }
    return result;
  }

  private walk(
    dir: string, depth = 0, root = dir,
  ): Array<{ absPath: string; sourceRef: string; kind: "app" | "notes" | "diagram" }> {
    if (depth > MAX_DEPTH) return [];
    const results: ReturnType<typeof this.walk> = [];
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return []; }

    const relDir = relative(root, dir);
    const posixRelDir = relDir.replace(/\\/g, "/");

    // Directory-level app detection — including root (the project itself can be an app)
    let isAppDir = false;
    if (entries.includes("package.json")) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        const scripts = pkg.scripts ?? {};
        const hasDev = !!scripts.dev || !!scripts.start;
        const dirName = dir.split(sep).pop() ?? "";
        const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
        const hasFramework = APP_DEP_KEYWORDS.some((kw) => deps.some((d) => d.includes(kw)));
        if (hasDev && (APP_DIR_NAMES.has(dirName) || hasFramework)) {
          const ref = posixRelDir ? `${posixRelDir}/:app` : ":app";
          results.push({ absPath: dir, sourceRef: ref, kind: "app" });
          isAppDir = true;
        }
      } catch { /* malformed package.json */ }
    }

    // Non-JS project detection — including root
    if (!isAppDir && !entries.includes("package.json")) {
      for (const marker of PROJECT_MARKERS) {
        if (entries.includes(marker)) {
          const ref = posixRelDir ? `${posixRelDir}/:app` : ":app";
          results.push({ absPath: dir, sourceRef: ref, kind: "app" });
          isAppDir = true;
          break;
        }
      }
    }

    for (const entry of entries) {
      const absPath = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try { stat = statSync(absPath); } catch { continue; }

      if (stat.isDirectory()) {
        if (!SKIP_DIRS.has(entry) && !entry.startsWith(".")) results.push(...this.walk(absPath, depth + 1, root));
        continue;
      }
      if (SKIP_FILE_PATTERNS.some((p) => p.test(entry))) continue;

      const posixRelFile = (posixRelDir ? posixRelDir + "/" : "") + entry;

      // Markdown files
      if (entry.endsWith(".md")) {
        results.push({ absPath, sourceRef: `${posixRelFile}:notes`, kind: "notes" });
      // Diagrams — mermaid files
      } else if (entry.endsWith(".mmd") || entry.endsWith(".mermaid")) {
        results.push({ absPath, sourceRef: `${posixRelFile}:diagram`, kind: "diagram" });
      // Standalone HTML files in non-root directories without package.json
      } else if (entry === "index.html" && depth > 0 && !entries.includes("package.json")) {
        results.push({ absPath: dir, sourceRef: `${posixRelFile}:app`, kind: "app" });
      }
    }
    return results;
  }

  private deriveGroup(_sourceRef: string, kind: "app" | "notes" | "diagram"): string | null {
    if (kind === "app") return "Apps";
    return "Docs";
  }

  private upsertCandidate(
    spaceId: string,
    candidate: { absPath: string; sourceRef: string; kind: "app" | "notes" | "diagram" },
    result: ScanResult,
  ): void {
    const { absPath, sourceRef, kind } = candidate;
    const existing = this.artifactStore.getBySpaceAndSourceRef(spaceId, sourceRef);

    if (existing) {
      if (existing.removed_at) {
        this.artifactStore.resurface(existing.id);
        result.resurfaced++;
        result.artifacts.push({ id: existing.id, label: existing.label, kind: existing.artifact_kind, sourceRef });
      } else {
        result.skipped++;
      }
      return;
    }

    // Derive label from path stem
    const pathPart = sourceRef.split(":")[0];
    const stem = pathPart.replace(/\/$/, "").split("/").pop() ?? pathPart;
    // For root-level artifacts (sourceRef = ":app"), use the folder name
    const label = stem ? stem.replace(/\.[^.]+$/, "") : absPath.split(sep).pop() ?? "project";

    let runtimeKind = "static_file";
    let storageConfig: Record<string, unknown> = { path: absPath };
    let runtimeConfig: Record<string, unknown> = {};

    if (kind === "app") {
      const pkgPath = join(absPath, "package.json");
      if (existsSync(pkgPath)) {
        // JS/TS project — use package.json for runtime config
        storageConfig = { path: pkgPath };
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
          const startCmd = pkg.scripts?.dev
            ? "npm run dev"
            : pkg.scripts?.start
            ? "npm start"
            : null;
          if (startCmd) {
            runtimeKind = "local_process";
            runtimeConfig = { command: startCmd, cwd: absPath };
          }
        } catch { /* package.json unreadable — stay static_file */ }
      } else {
        // Non-JS project or standalone HTML — point at a real file, not the directory
        const candidateFiles = ["index.html", "go.mod", "Cargo.toml", "pyproject.toml",
          "setup.py", "requirements.txt", "Gemfile", "pom.xml", "build.gradle", "Makefile"];
        const storagePath = candidateFiles.map(f => join(absPath, f)).find(f => existsSync(f)) ?? absPath;
        storageConfig = { path: storagePath };
      }
    }

    const group_name = this.deriveGroup(sourceRef, kind);
    const id = crypto.randomUUID();
    this.artifactStore.insert({
      id, owner_id: null, space_id: spaceId, label, artifact_kind: kind,
      storage_kind: "filesystem", storage_config: JSON.stringify(storageConfig),
      runtime_kind: runtimeKind, runtime_config: JSON.stringify(runtimeConfig),
      group_name, source_origin: "discovered", source_ref: sourceRef,
    });
    result.discovered++;
    result.artifacts.push({ id, label, kind, sourceRef });
  }
}
