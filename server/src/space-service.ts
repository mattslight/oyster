import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
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
    repoPath: row.repo_path,
    color: row.color,
    scanStatus: toScanStatus(row.scan_status),
    scanError: row.scan_error,
    lastScannedAt: row.last_scanned_at,
    lastScanSummary: row.last_scan_summary ? JSON.parse(row.last_scan_summary) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".cache"]);
const SKIP_FILE_PATTERNS = [/\.lock$/, /\.log$/];
const MAX_DEPTH = 4;
const APP_DIR_NAMES = new Set(["web", "admin", "app", "client", "frontend"]);
const APP_DEP_KEYWORDS = ["react", "vue", "next", "vite", "svelte"];

export class SpaceService {
  private scanning = new Set<string>();

  constructor(
    private spaceStore: SpaceStore,
    private artifactStore: ArtifactStore,
  ) {}

  createSpace(params: { name: string; repoPath?: string }): Space {
    const displayName = params.name.trim();
    if (!displayName) throw new Error("name must not be empty");
    const id = slugify(displayName);
    if (!id) throw new Error("name must contain at least one alphanumeric character");
    if (this.spaceStore.getById(id)) throw new Error(`Space "${id}" already exists`);

    let repoPath: string | null = null;
    if (params.repoPath) {
      const raw = params.repoPath.startsWith("~/")
        ? join(process.env.HOME ?? "", params.repoPath.slice(2))
        : params.repoPath;
      repoPath = resolve(raw);
      // Note: resolve() does not follow symlinks. Two symlinked paths to the
      // same repo will produce different normalised strings and bypass this check.
      // This is a known limitation — document it; Phase 4 can add fs.realpath().

      // Friendly duplicate check before hitting the UNIQUE constraint
      const existing = this.spaceStore.getByRepoPath(repoPath);
      if (existing) {
        throw new Error(`Repo path is already attached to space "${existing.id}"`);
      }
    }

    const color = SPACE_PALETTE[hashStr(id) % SPACE_PALETTE.length];
    this.spaceStore.insert({
      id, display_name: displayName, repo_path: repoPath, color,
      scan_status: "none", scan_error: null, last_scanned_at: null,
      last_scan_summary: null, ai_job_status: null, ai_job_error: null,
    });
    return rowToSpace(this.spaceStore.getById(id)!);
  }

  listSpaces(): Space[] { return this.spaceStore.getAll().map(rowToSpace); }
  getSpace(id: string): Space | null {
    const row = this.spaceStore.getById(id);
    return row ? rowToSpace(row) : null;
  }
  deleteSpace(id: string): void {
    this.artifactStore.getBySpaceId(id).forEach(a => this.artifactStore.delete(a.id));
    this.spaceStore.delete(id);
  }

  async scanSpace(spaceId: string): Promise<ScanResult> {
    const row = this.spaceStore.getById(spaceId);
    if (!row) throw new Error(`Space "${spaceId}" not found`);
    if (!row.repo_path) throw new Error(`Space "${spaceId}" has no repo_path`);
    const repoPath = row.repo_path;
    if (!existsSync(repoPath)) throw new Error(`repo_path does not exist: ${repoPath}`);
    if (!statSync(repoPath).isDirectory()) throw new Error(`repo_path is not a directory: ${repoPath}`);
    if (this.scanning.has(spaceId)) throw new Error(`Scan already in progress for space "${spaceId}"`);

    this.scanning.add(spaceId);
    this.spaceStore.update(spaceId, { scan_status: "scanning", scan_error: null });

    const result: ScanResult = { discovered: 0, skipped: 0, resurfaced: 0, errors: [], artifacts: [] };
    try {
      const candidates = this.walk(repoPath);
      for (const c of candidates) this.upsertCandidate(spaceId, c, result);
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

    // Directory-level app detection (depth > 0 only — skip root itself)
    if (depth > 0 && entries.includes("package.json")) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        const scripts = pkg.scripts ?? {};
        const hasDev = !!scripts.dev || !!scripts.start;
        const dirName = dir.split(sep).pop() ?? "";
        const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
        const hasFramework = APP_DEP_KEYWORDS.some((kw) => deps.some((d) => d.includes(kw)));
        if (hasDev && (APP_DIR_NAMES.has(dirName) || hasFramework)) {
          results.push({ absPath: dir, sourceRef: `${posixRelDir}/:app`, kind: "app" });
        }
      } catch { /* malformed package.json */ }
    }

    for (const entry of entries) {
      const absPath = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try { stat = statSync(absPath); } catch { continue; }

      if (stat.isDirectory()) {
        if (!SKIP_DIRS.has(entry)) results.push(...this.walk(absPath, depth + 1, root));
        continue;
      }
      if (SKIP_FILE_PATTERNS.some((p) => p.test(entry))) continue;

      const posixRelFile = (posixRelDir ? posixRelDir + "/" : "") + entry;

      if (depth === 0 && entry === "README.md") {
        results.push({ absPath, sourceRef: "README.md:notes", kind: "notes" });
      } else if (depth === 0 && entry === "CHANGELOG.md") {
        results.push({ absPath, sourceRef: "CHANGELOG.md:notes", kind: "notes" });
      } else if (posixRelDir.startsWith("docs") && entry.endsWith(".md")) {
        results.push({ absPath, sourceRef: `${posixRelFile}:notes`, kind: "notes" });
      } else if (entry.endsWith(".mmd") || entry.endsWith(".mermaid")) {
        results.push({ absPath, sourceRef: `${posixRelFile}:diagram`, kind: "diagram" });
      }
    }
    return results;
  }

  private deriveGroup(sourceRef: string, kind: "app" | "notes" | "diagram"): string | null {
    if (kind === "app") return "Apps";
    const pathPart = sourceRef.split(":")[0];
    const parts = pathPart.split("/").filter(Boolean);
    // Root-level files (README.md, CHANGELOG.md) — no group
    if (parts.length <= 1) return null;
    // Use the top-level directory as the group, capitalised
    const topDir = parts[0];
    return topDir.charAt(0).toUpperCase() + topDir.slice(1);
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
    const label = stem.replace(/\.[^.]+$/, "");

    let runtimeKind = "static_file";
    let storageConfig: Record<string, unknown> = { path: absPath };
    let runtimeConfig: Record<string, unknown> = {};

    if (kind === "app") {
      // Always point storage at package.json (a real file), not the directory itself.
      // Detection guarantees scripts.dev || scripts.start exists — use whichever is present.
      const pkgPath = join(absPath, "package.json");
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
      } catch { /* package.json unreadable — stay static_file, path already set */ }
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
