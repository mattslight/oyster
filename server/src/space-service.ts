import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { homedir } from "node:os";
import crypto from "node:crypto";
import ignore, { type Ignore } from "ignore";
import type { SpaceStore, SpaceRow, Source } from "./space-store.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { ArtifactService } from "./artifact-service.js";
import type { SessionStore } from "./session-store.js";
import type { Space, ScanResult } from "../../shared/types.js";
import { slugify, toScanStatus } from "./utils.js";

// Build a gitignore matcher from .gitignore at the scan root, if one exists.
// Returns null when there's nothing to honor — callers can skip the per-entry
// check entirely. Only the root .gitignore is read; nested .gitignore files
// are not layered (the 80% case for repo scanning, parity with
// `git check-ignore` for top-level patterns). Errors reading the file are
// swallowed — a malformed gitignore should not break the scan.
export function loadGitignore(rootDir: string): Ignore | null {
  const gitignorePath = join(rootDir, ".gitignore");
  if (!existsSync(gitignorePath)) return null;
  try {
    const contents = readFileSync(gitignorePath, "utf8");
    if (!contents.trim()) return null;
    return ignore().add(contents);
  } catch {
    return null;
  }
}

// Last non-empty path component, normalised. Same logic used at scan time and
// (if ever needed again) for slug-based migration backfill — single source of
// truth. Filters empty segments so root-ish paths like "/" or "C:\\" still
// produce a non-empty slug.
export function folderSlug(folderPath: string): string {
  const parts = resolve(folderPath).split(sep).filter(Boolean);
  return parts.pop() ?? folderPath;
}

function expandHome(rawPath: string): string {
  return rawPath.startsWith("~/")
    ? resolve(join(homedir(), rawPath.slice(2)))
    : resolve(rawPath);
}

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
    private artifactService: ArtifactService,
    private sessionStore: SessionStore,
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

  // Attach an external folder to a space. Returns the resulting Source — newly
  // inserted, restored from a soft-delete, or already-active no-op.
  addSource(spaceId: string, rawPath: string): Source {
    const row = this.spaceStore.getById(spaceId);
    if (!row) throw new Error(`Space "${spaceId}" not found`);

    const resolved = expandHome(rawPath);
    if (!existsSync(resolved)) throw new Error(`Path does not exist: ${resolved}`);
    if (!statSync(resolved).isDirectory()) throw new Error(`Path is not a directory: ${resolved}`);

    // Cross-space conflict / same-space no-op check.
    const active = this.spaceStore.getActiveSourceByPath(resolved);
    if (active) {
      if (active.space_id === spaceId) {
        // Re-attach to the same space is a no-op for the source row, but
        // still backfill — pre-existing orphan sessions for this cwd may
        // never have been swept (e.g. attached before the backfill behaviour
        // existed). Idempotent, so safe to run on every retry.
        this.sessionStore.backfillSourceForCwd(resolved, spaceId, active.id);
        return active;
      }
      const ownerName = this.spaceStore.getById(active.space_id)?.display_name ?? active.space_id;
      throw new Error(`Path is already attached to space "${ownerName}"`);
    }

    // Reattach-restore: a soft-deleted source for the same (space, path) wins
    // over inserting a fresh row. Same id survives — its artifacts will
    // resurface on the next scan via upsertCandidate.
    let source: Source;
    const removed = this.spaceStore.getSoftDeletedSourceByPathForSpace(spaceId, resolved);
    if (removed) {
      try {
        this.spaceStore.restoreSource(removed.id);
        source = { ...removed, removed_at: null };
      } catch (err) {
        // Race: between our check and the restore, another caller inserted a
        // fresh active source for the same path. Re-evaluate.
        if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
          source = this.resolveSourceConflict(spaceId, resolved, err);
        } else {
          throw err;
        }
      }
    } else {
      const id = crypto.randomUUID();
      try {
        this.spaceStore.addSource({ id, space_id: spaceId, type: "local_folder", path: resolved });
        source = this.spaceStore.getSourceById(id)!;
      } catch (err) {
        // Race: a concurrent caller inserted the same path between our check and
        // our insert. Re-evaluate.
        if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
          source = this.resolveSourceConflict(spaceId, resolved, err);
        } else {
          throw err;
        }
      }
    }

    // Re-attribute orphan sessions whose cwd matches — same side-effect as
    // createSpaceFromPath, so the Unsorted folder tile disappears once its
    // sessions get a home. Idempotent (only updates rows where space_id and
    // source_id are both NULL), so safe on the race-conflict path too.
    this.sessionStore.backfillSourceForCwd(resolved, spaceId, source.id);
    return source;
  }

  // Both addSource paths can race against the partial unique index on
  // sources(path) WHERE removed_at IS NULL. Surface the same friendly error
  // (or no-op return) as the up-front check would have produced.
  private resolveSourceConflict(spaceId: string, resolved: string, originalErr: unknown): Source {
    const raced = this.spaceStore.getActiveSourceByPath(resolved);
    if (raced) {
      if (raced.space_id === spaceId) return raced;
      const ownerName = this.spaceStore.getById(raced.space_id)?.display_name ?? raced.space_id;
      throw new Error(`Path is already attached to space "${ownerName}"`);
    }
    throw originalErr;
  }

  // Detach an external folder from a space. Soft-deletes both the source row
  // AND every artifact that came from it. Reversible via addSource(...) on the
  // same path — restoreSource keeps the same id and upsertCandidate resurfaces
  // soft-deleted artifacts on the next scan.
  removeSource(sourceId: string): void {
    const source = this.spaceStore.getSourceById(sourceId);
    if (!source) throw new Error(`Source "${sourceId}" not found`);
    if (source.removed_at) return; // already detached, no-op
    // Race guard: refuse to detach mid-scan. Otherwise the in-flight scan can
    // resurface artifacts we just soft-deleted (upsertCandidate's resurface
    // branch flips removed_at back to NULL). Caller can retry once the scan
    // completes.
    if (this.scanning.has(source.space_id)) {
      throw new Error(`Cannot detach while space "${source.space_id}" is scanning — try again in a moment.`);
    }
    // Atomic cascade: artifact bulk soft-delete + source soft-delete inside a
    // single transaction. If either fails the SQL rolls back together, so we
    // never leave a partial state (tiles gone but source still attached, or
    // vice versa). The cache invalidation in artifactService.removeBySource
    // is a JS state change, not SQL — it doesn't roll back, but an over-eager
    // cache invalidation just causes a re-read on next access (harmless).
    this.spaceStore.transaction(() => {
      this.artifactService.removeBySource(sourceId);
      this.spaceStore.softDeleteSource(sourceId);
    });
  }

  getSources(spaceId: string): Source[] {
    return this.spaceStore.getSources(spaceId);
  }

  getSourceById(sourceId: string): Source | undefined {
    return this.spaceStore.getSourceById(sourceId);
  }

  getActiveSourceByPath(path: string): Source | undefined {
    return this.spaceStore.getActiveSourceByPath(expandHome(path));
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

  // One-shot "promote folder to space": create a fresh space named after the
  // folder (or `name`), attach `path` as its sole source, and re-attribute any
  // orphan sessions whose cwd matches. If the attach step fails (path missing,
  // already attached elsewhere, etc.), we delete the just-created empty space
  // so the caller doesn't see ghost spaces from failed promotions.
  createSpaceFromPath(params: { path: string; name?: string }): { space: Space; source: Source; backfilled: number } {
    const rawPath = params.path?.trim();
    if (!rawPath) throw new Error("path is required");

    const resolved = expandHome(rawPath);
    if (!existsSync(resolved)) throw new Error(`Path does not exist: ${resolved}`);
    if (!statSync(resolved).isDirectory()) throw new Error(`Path is not a directory: ${resolved}`);

    const active = this.spaceStore.getActiveSourceByPath(resolved);
    if (active) {
      const ownerName = this.spaceStore.getById(active.space_id)?.display_name ?? active.space_id;
      throw new Error(`Path is already attached to space "${ownerName}"`);
    }

    // Folder basenames usually come in lowercase from the filesystem
    // (`blunderfixer`). Title-case the first character so the saved
    // displayName matches the chip / header convention (Tokinvest, Oyster).
    // An explicit `name` from the caller is honoured verbatim.
    const rawName = params.name?.trim() || folderSlug(resolved);
    const displayName = params.name?.trim()
      ? rawName
      : rawName.charAt(0).toUpperCase() + rawName.slice(1);
    const id = slugify(displayName);
    if (!id) throw new Error("name must contain at least one alphanumeric character");
    if (this.spaceStore.getById(id)) throw new Error(`Space "${id}" already exists`);

    const space = this.createSpace({ name: displayName });
    let source: Source;
    try {
      source = this.addSource(space.id, resolved);
    } catch (err) {
      // Roll back the just-created (empty) space so failed promotions don't
      // leave orphan spaces behind.
      try { this.spaceStore.delete(space.id); } catch { /* best-effort cleanup */ }
      throw err;
    }

    const backfilled = this.sessionStore.backfillSourceForCwd(resolved, space.id, source.id);
    return { space, source, backfilled };
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

    const sources = this.spaceStore.getSources(spaceId).filter(s => s.type === "local_folder");
    if (sources.length === 0) throw new Error(`Space "${spaceId}" has no folders`);

    if (this.scanning.has(spaceId)) throw new Error(`Scan already in progress for space "${spaceId}"`);

    this.scanning.add(spaceId);
    this.spaceStore.update(spaceId, { scan_status: "scanning", scan_error: null });

    const result: ScanResult = { discovered: 0, skipped: 0, resurfaced: 0, errors: [], artifacts: [] };
    try {
      for (const source of sources) {
        const folderPath = source.path;
        if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
          result.errors.push(`Skipped missing folder: ${folderPath}`);
          continue;
        }
        const slug = folderSlug(folderPath);
        const gitignore = loadGitignore(folderPath);
        const candidates = this.walk(folderPath, 0, folderPath, gitignore);
        for (const c of candidates) {
          // Namespace sourceRef with the folder's basename — reduces (but does
          // not eliminate) collisions when a space has multiple paths. Two
          // paths sharing a basename (e.g. ~/a/foo and ~/b/foo) still collide.
          // Truly correct dedup would key on source_id; we keep the slug
          // prefix only so existing pre-#208 rows still match.
          c.sourceRef = `${slug}/${c.sourceRef}`;
          this.upsertCandidate(spaceId, source.id, c, result);
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
    dir: string, depth = 0, root = dir, gitignore: Ignore | null = null,
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

      // Path used for gitignore matching — must be relative to the root
      // (which is the gitignore's directory) and use posix separators. The
      // `ignore` package requires a trailing "/" for directories so the
      // pattern e.g. `dist/` matches a directory named `dist`.
      const relForIgnore = posixRelDir
        ? `${posixRelDir}/${entry}${stat.isDirectory() ? "/" : ""}`
        : `${entry}${stat.isDirectory() ? "/" : ""}`;

      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
        if (gitignore?.ignores(relForIgnore)) continue;
        results.push(...this.walk(absPath, depth + 1, root, gitignore));
        continue;
      }
      if (SKIP_FILE_PATTERNS.some((p) => p.test(entry))) continue;
      if (gitignore?.ignores(relForIgnore)) continue;

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
    sourceId: string,
    candidate: { absPath: string; sourceRef: string; kind: "app" | "notes" | "diagram" },
    result: ScanResult,
  ): void {
    const { absPath, sourceRef, kind } = candidate;
    const existing = this.artifactStore.getBySpaceAndSourceRef(spaceId, sourceRef);

    if (existing) {
      // Two paths to handle explicitly:
      //   (a) soft-deleted   → resurface AND (re-)claim source_id. The artifact
      //                        had previously been linked to *this* source and
      //                        was soft-deleted by detach; reattach legitimately
      //                        owns it again. Safe even when multiple sources
      //                        have basename collisions, because we filter on
      //                        (space_id, source_ref) which any colliding
      //                        source would also match — the most-recent active
      //                        source wins, matching today's flat ordering.
      //   (b) live but NULL  → backfill source_id (post-migration legacy row).
      //   (c) live with non-null source_id → leave source_id alone, even if it
      //                        differs. Otherwise basename collisions between
      //                        two attached folders would silently steal each
      //                        other's tiles, breaking detach later.
      if (existing.removed_at) {
        this.artifactStore.update(existing.id, { removed_at: null, source_id: sourceId });
        result.resurfaced++;
        result.artifacts.push({ id: existing.id, label: existing.label, kind: existing.artifact_kind, sourceRef });
      } else {
        if (existing.source_id === null) {
          this.artifactStore.update(existing.id, { source_id: sourceId });
        }
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
      source_id: sourceId,
    });
    result.discovered++;
    result.artifacts.push({ id, label, kind, sourceRef });
  }
}
