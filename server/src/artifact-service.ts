import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { resolve, basename, dirname, join, sep } from "node:path";
import crypto from "node:crypto";
import type { ArtifactStore, ArtifactRow } from "./artifact-store.js";
import type { SpaceStore } from "./space-store.js";
import type { Artifact, ArtifactKind, ArtifactStatus } from "../../shared/types.js";
import { isPortOpen, isStarting, clearStarting, getGeneratedArtifactEntries } from "./process-manager.js";
import { slugify, inferKindFromPath, toArtifactKind } from "./utils.js";
import { debug, debugEnabled } from "./debug.js";

// ── Config shapes (validated here, not in route handlers) ──

interface LocalProcessConfig {
  command: string;
  cwd: string;
  port: number;
}

interface FilesystemStorageConfig {
  path: string;
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function storagePathOf(row: ArtifactRow): string | undefined {
  if (row.storage_kind !== "filesystem") return undefined;
  const parsed = parseJson(row.storage_config);
  return typeof parsed.path === "string" ? parsed.path : undefined;
}

// Returns true if the path exists, false only on ENOENT/ENOTDIR, and rethrows
// on any other error (permissions, transient IO). Narrower than existsSync,
// which would swallow those and let us wipe DB rows whose backing files are
// temporarily inaccessible (e.g. synced drive offline, permission glitch).
function pathExistsOrThrow(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw err;
  }
}

const KIND_EXT: Record<ArtifactKind, string> = {
  notes: ".md", diagram: ".mmd",
  app: ".html", deck: ".html", wireframe: ".html", table: ".html", map: ".html",
};

// Extensions the viewer's MIME map (server/src/index.ts) knows how to serve
// with a correct Content-Type. Keep in sync if the map grows.
const ALLOWED_EXTENSIONS = new Set([".md", ".html", ".mmd", ".mermaid"]);

function normalizeExtension(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  const withDot = normalized.startsWith(".") ? normalized : `.${normalized}`;
  if (!ALLOWED_EXTENSIONS.has(withDot)) {
    throw new Error(`extension must be one of ${[...ALLOWED_EXTENSIONS].join(", ")}`);
  }
  return withDot;
}

// ── Service ──

export class ArtifactService {
  // Archived-paths cache: /api/artifacts polls every 5s and each hit used
  // to re-run the archived-rows SQL + Set construction. Cache the Set in
  // memory, invalidate on any call that mutates removed_at. Stays O(active
  // artifacts) in steady state instead of O(archived).
  private archivedPathsCache: Set<string> | null = null;
  private invalidateArchivedPaths(): void { this.archivedPathsCache = null; }

  constructor(private store: ArtifactStore, private userlandDir?: string, private spaceStore?: SpaceStore, private workerBase?: string) {}

  async getAllArtifacts(onArtifactRemoved?: (id: string, filePath: string) => void): Promise<Artifact[]> {
    const allRows = this.store.getAll();

    // Self-heal: drop DB rows whose filesystem backing is definitively gone.
    // Happens after `oyster uninstall <id>`, manual folder removal, or a
    // crashed install. The in-memory map already self-heals; this closes
    // the same loop for persisted rows so the surface doesn't show ghosts.
    //
    // Rows with a filesystem path get their existence checked via
    // pathExistsOrThrow (narrower than existsSync — only ENOENT/ENOTDIR
    // counts as "gone", so a temporary permission blip doesn't wipe data).
    // Parsed paths are cached to avoid re-parsing storage_config below.
    const rows: ArtifactRow[] = [];
    const pathByRowIdx = new Map<number, string>();
    for (const row of allRows) {
      const storagePath = storagePathOf(row);
      if (storagePath) {
        if (!pathExistsOrThrow(storagePath)) {
          this.store.remove(row.id);
          this.invalidateArchivedPaths();
          onArtifactRemoved?.(row.id, storagePath);
          continue;
        }
        pathByRowIdx.set(rows.length, storagePath);
      }
      rows.push(row);
    }

    const sourceLabels = this.buildSourceLabelMap(rows);
    const persisted = await Promise.all(rows.map((row) => this.rowToArtifact(row, sourceLabels)));

    // Map of filePath → persisted artifact index — used to suppress and merge gen: twins
    const dbPathToIdx = new Map<string, number>();
    for (const [idx, storagePath] of pathByRowIdx) {
      dbPathToIdx.set(storagePath, idx);
    }

    const entries = getGeneratedArtifactEntries(onArtifactRemoved);
    const gen: Artifact[] = [];
    // Paths of archived filesystem-backed rows — used to suppress in-memory
    // scanner shadows so a soft-deleted artifact doesn't reappear on the
    // surface just because its backing file still exists on disk.
    const archivedPaths = this.store.getArchivedFilePaths();

    for (const e of entries) {
      if (e.filePath && archivedPaths.has(e.filePath)) continue;
      // Manifest-based gen ids are "gen:<plugin-folder>"; strip the prefix
      // to get the folder name (under `apps/` for installed bundles, under
      // `spaces/<space>/` for AI-generated ones). Used as pluginId so
      // Uninstall has a stable handle even after the DB reconciles the
      // artifact to a UUID.
      const pluginFolderId = e.plugin && e.id.startsWith("gen:") ? e.id.slice(4) : undefined;

      const idx = e.filePath ? dbPathToIdx.get(e.filePath) : undefined;
      if (idx !== undefined) {
        // Suppressed twin — forward icon onto the DB artifact so it isn't lost.
        // Non-builtin scan entries also have builtin=false, so the plugin
        // flag must come from the detector's explicit `plugin` marker, not
        // `!e.builtin` (which would misclassify regular scan-backed notes).
        const dbArtifact = persisted[idx];
        if (e.icon && !dbArtifact.icon) dbArtifact.icon = e.icon;
        if (e.iconStatus && !dbArtifact.iconStatus) dbArtifact.iconStatus = e.iconStatus;
        if (e.plugin) {
          dbArtifact.plugin = true;
          if (pluginFolderId) dbArtifact.pluginId = pluginFolderId;
        }
      } else {
        // No DB twin: either a builtin (never reconciled to DB) or a manifest
        // plugin whose DB row hasn't been reconciled yet. Carry through the
        // builtin / plugin flags so the UI can gate destructive actions.
        const { filePath: _f, builtin, plugin, ...a } = e;
        const artifact = a as Artifact;
        if (builtin) artifact.builtin = true;
        if (plugin) {
          artifact.plugin = true;
          if (pluginFolderId) artifact.pluginId = pluginFolderId;
        }
        gen.push(artifact);
      }
    }

    return [...persisted, ...gen];
  }

  async getArtifactById(id: string): Promise<Artifact | undefined> {
    const row = this.store.getById(id);
    if (!row) return undefined;
    return this.rowToArtifact(row);
  }

  getAppConfig(id: string): LocalProcessConfig | undefined {
    const row = this.store.getById(id);
    if (!row || row.runtime_kind !== "local_process") return undefined;
    const config = parseJson(row.runtime_config);
    const command = config.command as string | undefined;
    const cwd = (config.cwd as string | undefined) || (JSON.parse(row.storage_config) as { path?: string }).path;
    const port = config.port as number | undefined;
    if (!command || !cwd || !port) return undefined;
    return { command, cwd, port };
  }

  getDocFile(id: string): string | undefined {
    const row = this.store.getById(id);
    if (!row) return undefined;
    if (row.storage_kind !== "filesystem") return undefined;
    const storage = JSON.parse(row.storage_config) as { path?: string };
    return storage.path;
  }

  // ── Registration ──

  async registerArtifact(
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
  ): Promise<Artifact> {
    debug("artifact-svc", "registerArtifact called", { path: params.path, label: params.label, id: params.id ?? null, space_id: params.space_id });
    const absPath = resolve(params.path);

    // Validate file exists
    if (!existsSync(absPath)) {
      throw new Error(`File does not exist: ${absPath}`);
    }

    // Validate path is under an approved root (skip if no roots specified — trusted caller)
    if (approvedRoots.length > 0) {
      const normalizedRoots = approvedRoots.map((r) => resolve(r));
      const isApproved = normalizedRoots.some((root) => absPath.startsWith(root + sep) || absPath === root);
      if (!isApproved) {
        throw new Error(
          `Path is not under an approved root. Allowed roots: ${normalizedRoots.join(", ")}`,
        );
      }
    }

    // Infer ID from filename stem if not provided
    const id = params.id || basename(absPath).replace(/\.[^.]+$/, "");
    debug("artifact-svc", "registerArtifact id resolved", { id, fromParams: !!params.id, absPath });

    // Log dedup-by-path observability so #167 diagnosis is easy; behaviour unchanged here.
    // Gated on debugEnabled so we don't pay for an extra SQLite query in hot paths when debug is off.
    if (debugEnabled) {
      const byPath = this.store.getByPath(absPath);
      if (byPath) {
        debug("artifact-svc", "registerArtifact path already has active row", { existingId: byPath.id, incomingId: id, path: absPath });
      }
    }

    // If a removed record exists with this ID, resurface and update it
    const existing = this.store.getById(id);
    if (existing) {
      if (existing.removed_at) {
        this.store.resurface(id);
        this.invalidateArchivedPaths();
        const kind = params.artifact_kind || inferKindFromPath(absPath);
        this.store.update(id, {
          space_id: params.space_id,
          label: params.label,
          artifact_kind: kind,
          group_name: params.group_name || null,
          storage_config: JSON.stringify({ path: absPath }),
          source_origin: params.source_origin ?? "manual",
        });
        return await this.rowToArtifact(this.store.getById(id)!);
      }
      throw new Error(`Artifact with id "${id}" already exists`);
    }

    // Infer kind from file extension/name
    const kind = params.artifact_kind || inferKindFromPath(absPath);

    this.store.insert({
      id,
      owner_id: null,
      space_id: params.space_id,
      label: params.label,
      artifact_kind: kind,
      storage_kind: "filesystem",
      storage_config: JSON.stringify({ path: absPath }),
      runtime_kind: "static_file",
      runtime_config: "{}",
      group_name: params.group_name || null,
      source_origin: params.source_origin ?? "manual",
      source_ref: null,
    });

    return {
      id,
      label: params.label,
      artifactKind: kind,
      spaceId: params.space_id,
      status: "ready",
      runtimeKind: "static_file",
      runtimeConfig: {},
      url: `/docs/${id}`,
      createdAt: new Date().toISOString(),
      groupName: params.group_name || undefined,
    };
  }

  // ── Creation ──

  async createArtifact(
    params: {
      space_id: string;
      label: string;
      artifact_kind: ArtifactKind;
      content: string;
      subdir?: string;
      group_name?: string;
      source_origin?: "manual" | "discovered" | "ai_generated";
      extension?: string;
    },
    // Caller provides the pre-resolved path to this space's native folder
    // (e.g. `~/Oyster/spaces/tokinvest`). The service stays layout-agnostic;
    // the resolver lives in index.ts so swapping to a first-class sources
    // table later (#208) is a one-function change at the top, not a sweep
    // through every service caller.
    spaceNativePath: string,
  ): Promise<Artifact> {
    debug("artifact-svc", "createArtifact called", { label: params.label, space_id: params.space_id, kind: params.artifact_kind, subdir: params.subdir ?? null });
    const label = params.label.trim();
    const space_id = params.space_id.trim();
    if (!label) throw new Error("label must not be empty");
    if (!space_id) throw new Error("space_id must not be empty");

    const slug = slugify(label);
    if (!slug) throw new Error("label must contain at least one alphanumeric character");

    const id = crypto.randomUUID();

    // Subdir containment check (resolved path, not string scan)
    const baseDir = spaceNativePath;
    const targetDir = params.subdir ? resolve(baseDir, params.subdir) : baseDir;
    if (targetDir !== baseDir && !targetDir.startsWith(baseDir + sep)) {
      throw new Error("subdir must stay within the space directory");
    }

    const ext = params.extension !== undefined
      ? normalizeExtension(params.extension)
      : KIND_EXT[params.artifact_kind];
    const absPath = join(targetDir, `${slug}${ext}`);
    debug("artifact-svc", "createArtifact writing file", { id, slug, absPath });

    // Filesystem collision check + exclusive write
    mkdirSync(targetDir, { recursive: true });
    if (existsSync(absPath)) {
      throw new Error(`File already exists at path "${absPath}"`);
    }
    writeFileSync(absPath, params.content, { encoding: "utf8", flag: "wx" });

    // Register — best-effort rollback on DB failure.
    // Approved-root check confirms the file we just wrote stayed within the
    // space's native folder (stricter than the old `[userlandDir]` check —
    // the subdir containment above already guarantees this).
    try {
      return await this.registerArtifact(
        { path: absPath, space_id, label, artifact_kind: params.artifact_kind, group_name: params.group_name, id, source_origin: params.source_origin },
        [spaceNativePath],
      );
    } catch (err) {
      try { unlinkSync(absPath); } catch {}
      throw err;
    }
  }

  // ── Removal ──

  removeArtifact(id: string): void {
    const row = this.store.getById(id);
    if (!row) throw new Error(`Artifact "${id}" not found`);
    this.store.remove(id);
    this.invalidateArchivedPaths();
  }

  // ── Reconciliation ──

  reconcileGeneratedArtifact(
    artifact: Artifact,
    filePath: string,
    userlandDir: string,
    archivedPaths?: Set<string>,
  ): void {
    debug("reconcile", "start", { genId: artifact.id, label: artifact.label, filePath });
    if (this.store.getByPath(filePath)) {
      debug("reconcile", "skipped: active row exists for path", { filePath });
      return; // already registered (active row)
    }
    // If the user archived this path previously, the scanner will keep
    // seeing the file on disk and a naive reconcile would create a fresh
    // active row next to the archived one — effectively ignoring the
    // archive. Skip reconciliation when an archived row already claims
    // this path; the user has to restore (#archived → Restore) to bring
    // it back.
    //
    // Callers that reconcile many artifacts in one pass (e.g. the boot
    // loop) should pass a pre-loaded `archivedPaths` set to avoid re-
    // querying for every artifact.
    const archived = archivedPaths ?? this.store.getArchivedFilePaths();
    if (archived.has(filePath)) {
      debug("reconcile", "skipped: archived path", { filePath });
      return;
    }
    console.log(`[reconcile] ${artifact.label} → DB`);
    debug("reconcile", "inserting new row", { label: artifact.label, filePath, newId: "pending-uuid" });
    try {
      this.registerArtifact(
        { path: filePath, space_id: artifact.spaceId, label: artifact.label, artifact_kind: artifact.artifactKind, id: crypto.randomUUID() },
        [userlandDir],
      );
    } catch (err) {
      console.error(`[reconcile] failed for ${artifact.label}:`, err);
    }
  }

  // Exposed so callers running a reconcile pass can query once. Cached
  // in-memory and invalidated whenever a mutation touches removed_at.
  getArchivedFilePaths(): Set<string> {
    if (!this.archivedPathsCache) {
      this.archivedPathsCache = this.store.getArchivedFilePaths();
    }
    return this.archivedPathsCache;
  }

  // ── Update ──

  async updateArtifact(
    id: string,
    fields: { label?: string; space_id?: string; group_name?: string | null; artifact_kind?: ArtifactKind },
  ): Promise<Artifact> {
    const row = this.store.getById(id);
    if (!row) throw new Error(`Artifact "${id}" not found`);

    const updateable: Partial<ArtifactRow> = {};
    if (fields.label !== undefined) {
      const label = fields.label.trim();
      if (!label) throw new Error("label must not be empty");
      updateable.label = label;
    }
    if (fields.space_id !== undefined) {
      const space_id = fields.space_id.trim();
      if (!space_id) throw new Error("space_id must not be empty");
      updateable.space_id = space_id;
    }
    if (fields.artifact_kind !== undefined) updateable.artifact_kind = fields.artifact_kind;
    if ("group_name" in fields) updateable.group_name = fields.group_name ?? null;

    if (Object.keys(updateable).length > 0) {
      this.store.update(id, updateable);
    }

    return this.rowToArtifact(this.store.getById(id)!);
  }

  // Targeted lookup used by the session inspector (#253). Avoids the
  // full enumeration + per-row fs-stat dance of getAllArtifacts(), which
  // is wasteful when we only need ~10 known IDs (a session's touched
  // artefact list). Missing rows are silently skipped — the caller
  // already filters absent ones out of its response.
  async getArtifactsByIds(ids: string[]): Promise<Artifact[]> {
    if (ids.length === 0) return [];
    const rows: ArtifactRow[] = [];
    for (const id of ids) {
      const row = this.store.getById(id);
      if (row) rows.push(row);
    }
    const sourceLabels = this.buildSourceLabelMap(rows);
    return Promise.all(rows.map((row) => this.rowToArtifact(row, sourceLabels)));
  }

  // ── Archived-view helpers ──

  async getArchivedArtifacts(): Promise<Artifact[]> {
    const rows = this.store.getAllArchived();
    const sourceLabels = this.buildSourceLabelMap(rows);
    return Promise.all(rows.map((row) => this.rowToArtifact(row, sourceLabels)));
  }

  restoreArtifact(id: string): void {
    const row = this.store.getById(id);
    if (!row) throw new Error(`Artifact "${id}" not found`);
    if (!row.removed_at) throw new Error(`Artifact "${id}" is not archived`);
    this.store.resurface(id);
    this.invalidateArchivedPaths();
  }

  // ── Group (folder) bulk operations ──
  // group_name is just a string on each artifact — no separate groups table.
  // Renaming a group = bulk-update group_name on every artifact in the space
  // that currently matches the old name. Archiving a group = bulk soft-delete
  // everything in it.

  renameGroup(spaceId: string, oldName: string, newName: string): number {
    const trimmed = newName.trim();
    if (!trimmed) throw new Error("new group name must not be empty");
    if (!oldName) throw new Error("old group name must not be empty");
    const rows = this.store.getBySpaceId(spaceId).filter((r) => r.group_name === oldName);
    for (const row of rows) this.store.update(row.id, { group_name: trimmed });
    return rows.length;
  }

  archiveGroup(spaceId: string, name: string): number {
    if (!name) throw new Error("group name must not be empty");
    const rows = this.store.getBySpaceId(spaceId).filter((r) => r.group_name === name);
    for (const row of rows) this.store.remove(row.id);
    if (rows.length > 0) this.invalidateArchivedPaths();
    return rows.length;
  }

  // Bulk soft-delete every live artifact attached to a source — the detach
  // cascade fired by space-service.removeSource(). Mirrors archiveGroup:
  // single SQL UPDATE for the rows, one cache invalidation at the end.
  removeBySource(sourceId: string): number {
    const changed = this.store.removeBySourceId(sourceId);
    if (changed > 0) this.invalidateArchivedPaths();
    return changed;
  }

  // ── Private ──

  // Pre-resolve a sources Map<id, basename-label> once per batch caller so
  // listing many linked-folder tiles doesn't N+1 the sources table. One SQL
  // roundtrip via WHERE id IN (...). Stores the basename only — absolute
  // paths never leave the server via /api/artifacts. Single-row callers can
  // pass undefined and pay the per-row lookup.
  private buildSourceLabelMap(rows: ArtifactRow[]): Map<string, string> {
    const map = new Map<string, string>();
    if (!this.spaceStore) return map;
    const ids = new Set<string>();
    for (const row of rows) {
      if (row.source_id) ids.add(row.source_id);
    }
    if (ids.size === 0) return map;
    for (const source of this.spaceStore.getSourcesByIds([...ids])) {
      map.set(source.id, basename(source.path));
    }
    return map;
  }

  private async rowToArtifact(row: ArtifactRow, sourceLabels?: Map<string, string>): Promise<Artifact> {
    const runtimeConfig = parseJson(row.runtime_config);
    // Resolve a display label for the linked source so the UI can render the
    // "↗" provenance glyph without a second fetch. Basename only — full path
    // is server-private (drilldown belongs to a separately-gated endpoint).
    let sourceLabel: string | null = null;
    if (row.source_id) {
      if (sourceLabels) {
        sourceLabel = sourceLabels.get(row.source_id) ?? null;
      } else if (this.spaceStore) {
        const path = this.spaceStore.getSourceById(row.source_id)?.path;
        sourceLabel = path ? basename(path) : null;
      }
    }

    const publication = row.share_token && this.workerBase
      ? {
          shareToken: row.share_token,
          shareUrl: `${this.workerBase}/p/${row.share_token}`,
          shareMode: row.share_mode!,
          publishedAt: row.published_at!,
          updatedAt: row.share_updated_at!,
          unpublishedAt: row.unpublished_at,
        }
      : undefined;

    if (row.runtime_kind === "local_process") {
      const port = (runtimeConfig.port as number) || 0;
      const portOpen = await isPortOpen(port);
      let status: ArtifactStatus;

      if (isStarting(row.id) && !portOpen) {
        status = "starting";
      } else if (portOpen) {
        status = "online";
        clearStarting(row.id);
      } else {
        status = "offline";
      }

      return {
        id: row.id,
        label: row.label,
        artifactKind: toArtifactKind(row.artifact_kind),
        spaceId: row.space_id,
        status,
        runtimeKind: row.runtime_kind,
        runtimeConfig,
        url: `http://localhost:${port}`,
        createdAt: row.created_at,
        groupName: row.group_name || undefined,
        sourceLabel,
        sourceOrigin: row.source_origin,
        sourceId: row.source_id,
        ...this.resolveIcon(row),
        ...(publication ? { publication } : {}),
      };
    }

    // static_file, redirect, etc.
    let url: string;
    if (row.runtime_kind === "redirect") {
      url = (runtimeConfig.url as string) || "";
    } else {
      url = `/docs/${row.id}`;
    }

    return {
      id: row.id,
      label: row.label,
      artifactKind: toArtifactKind(row.artifact_kind),
      spaceId: row.space_id,
      status: "ready",
      runtimeKind: row.runtime_kind,
      runtimeConfig,
      url,
      createdAt: row.created_at,
      groupName: row.group_name || undefined,
      sourceLabel,
      sourceOrigin: row.source_origin,
      ...this.resolveIcon(row),
      ...(publication ? { publication } : {}),
    };
  }

  private resolveIcon(row: ArtifactRow): { icon?: string; iconStatus?: "ready" } {
    if (row.storage_kind !== "filesystem") return {};
    try {
      const filePath = (JSON.parse(row.storage_config) as { path?: string }).path;
      if (!filePath) return {};

      // Check dedicated per-artifact icons dir first (used for external/flat artifacts)
      if (this.userlandDir) {
        const dedicatedPath = join(this.userlandDir, "icons", row.id, "icon.png");
        if (existsSync(dedicatedPath)) {
          return { icon: `/artifacts/icons/${row.id}/icon.png`, iconStatus: "ready" };
        }
      }

      // Fall back to icon.png alongside the source file or one level up (artifact root)
      const dir = dirname(filePath);
      const iconPath = join(dir, "icon.png");
      if (existsSync(iconPath)) {
        return { icon: `/artifacts/${basename(dir)}/icon.png`, iconStatus: "ready" };
      }
      const parentDir = dirname(dir);
      const parentIconPath = join(parentDir, "icon.png");
      if (existsSync(parentIconPath)) {
        return { icon: `/artifacts/${basename(parentDir)}/icon.png`, iconStatus: "ready" };
      }
    } catch {}
    return {};
  }
}
