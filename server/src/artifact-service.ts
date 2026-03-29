import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, basename, dirname, join, sep } from "node:path";
import crypto from "node:crypto";
import type { ArtifactStore, ArtifactRow } from "./artifact-store.js";
import type { Artifact, ArtifactKind, ArtifactStatus } from "../../shared/types.js";
import { isPortOpen, isStarting, clearStarting, getGeneratedArtifactEntries } from "./process-manager.js";
import { slugify, inferKindFromPath } from "./utils.js";

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

const KIND_EXT: Record<ArtifactKind, string> = {
  notes: ".md", diagram: ".mmd",
  app: ".html", deck: ".html", wireframe: ".html", table: ".html", map: ".html",
};

// ── Service ──

export class ArtifactService {
  constructor(private store: ArtifactStore, private userlandDir?: string) {}

  async getAllArtifacts(onArtifactRemoved?: (id: string, filePath: string) => void): Promise<Artifact[]> {
    const rows = this.store.getAll();
    const persisted = await Promise.all(rows.map((row) => this.rowToArtifact(row)));

    // Map of filePath → persisted artifact index — used to suppress and merge gen: twins
    const dbPathToIdx = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) {
      try {
        const p = (JSON.parse(rows[i].storage_config) as { path?: string }).path;
        if (p) dbPathToIdx.set(p, i);
      } catch {}
    }

    const entries = getGeneratedArtifactEntries(onArtifactRemoved);
    const gen: Artifact[] = [];

    for (const e of entries) {
      const idx = e.filePath ? dbPathToIdx.get(e.filePath) : undefined;
      if (idx !== undefined) {
        // Suppressed twin — forward icon onto the DB artifact so it isn't lost
        const dbArtifact = persisted[idx];
        if (e.icon && !dbArtifact.icon) dbArtifact.icon = e.icon;
        if (e.iconStatus && !dbArtifact.iconStatus) dbArtifact.iconStatus = e.iconStatus;
      } else {
        const { filePath: _f, builtin: _b, ...a } = e;
        gen.push(a as Artifact);
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
    const cwd = (config.cwd as string | undefined) || (parseJson(row.storage_config) as FilesystemStorageConfig).path;
    const port = config.port as number | undefined;
    if (!command || !cwd || !port) return undefined;
    return { command, cwd, port };
  }

  getDocFile(id: string): string | undefined {
    const row = this.store.getById(id);
    if (!row) return undefined;
    if (row.storage_kind !== "filesystem") return undefined;
    const storage = parseJson(row.storage_config) as FilesystemStorageConfig;
    return storage.path;
  }

  // ── Registration ──

  registerArtifact(
    params: {
      path: string;
      space_id: string;
      label: string;
      id?: string;
      artifact_kind?: ArtifactKind;
      group_name?: string;
    },
    approvedRoots: string[],
  ): Artifact {
    const absPath = resolve(params.path);

    // Validate file exists
    if (!existsSync(absPath)) {
      throw new Error(`File does not exist: ${absPath}`);
    }

    // Validate path is under an approved root
    const normalizedRoots = approvedRoots.map((r) => resolve(r));
    const isApproved = normalizedRoots.some((root) => absPath.startsWith(root + "/") || absPath === root);
    if (!isApproved) {
      throw new Error(
        `Path is not under an approved root. Allowed roots: ${normalizedRoots.join(", ")}`,
      );
    }

    // Infer ID from filename stem if not provided
    const id = params.id || basename(absPath).replace(/\.[^.]+$/, "");

    // Validate uniqueness
    if (this.store.getById(id)) {
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
      source_origin: "manual",
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

  createArtifact(
    params: {
      space_id: string;
      label: string;
      artifact_kind: ArtifactKind;
      content: string;
      subdir?: string;
      group_name?: string;
    },
    userlandDir: string,
  ): Artifact {
    const label = params.label.trim();
    const space_id = params.space_id.trim();
    if (!label) throw new Error("label must not be empty");
    if (!space_id) throw new Error("space_id must not be empty");

    const slug = slugify(label);
    if (!slug) throw new Error("label must contain at least one alphanumeric character");

    const id = crypto.randomUUID();

    // Subdir containment check (resolved path, not string scan)
    const baseDir = join(userlandDir, space_id);
    const targetDir = params.subdir ? resolve(baseDir, params.subdir) : baseDir;
    if (targetDir !== baseDir && !targetDir.startsWith(baseDir + sep)) {
      throw new Error("subdir must stay within the space directory");
    }

    const ext = KIND_EXT[params.artifact_kind];
    const absPath = join(targetDir, `${slug}${ext}`);

    // Filesystem collision check + exclusive write
    mkdirSync(targetDir, { recursive: true });
    if (existsSync(absPath)) {
      throw new Error(`File already exists at path "${absPath}"`);
    }
    writeFileSync(absPath, params.content, { encoding: "utf8", flag: "wx" });

    // Register — best-effort rollback on DB failure
    try {
      return this.registerArtifact(
        { path: absPath, space_id, label, artifact_kind: params.artifact_kind, group_name: params.group_name, id },
        [userlandDir],
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
  }

  // ── Reconciliation ──

  reconcileGeneratedArtifact(artifact: Artifact, filePath: string, userlandDir: string): void {
    if (this.store.getByPath(filePath)) return; // already registered
    console.log(`[reconcile] ${artifact.label} → DB`);
    try {
      this.registerArtifact(
        { path: filePath, space_id: artifact.spaceId, label: artifact.label, artifact_kind: artifact.artifactKind, id: crypto.randomUUID() },
        [userlandDir],
      );
    } catch (err) {
      console.error(`[reconcile] failed for ${artifact.label}:`, err);
    }
  }

  // ── Update ──

  async updateArtifact(
    id: string,
    fields: { label?: string; space_id?: string; group_name?: string | null },
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
    if ("group_name" in fields) updateable.group_name = fields.group_name ?? null;

    if (Object.keys(updateable).length > 0) {
      this.store.update(id, updateable);
    }

    return this.rowToArtifact(this.store.getById(id)!);
  }

  // ── Private ──

  private async rowToArtifact(row: ArtifactRow): Promise<Artifact> {
    const runtimeConfig = parseJson(row.runtime_config);

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
        artifactKind: row.artifact_kind as ArtifactKind,
        spaceId: row.space_id,
        status,
        runtimeKind: row.runtime_kind,
        runtimeConfig,
        url: `http://localhost:${port}`,
        createdAt: row.created_at,
        groupName: row.group_name || undefined,
        ...this.resolveIcon(row),
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
      artifactKind: row.artifact_kind as ArtifactKind,
      spaceId: row.space_id,
      status: "ready",
      runtimeKind: row.runtime_kind,
      runtimeConfig,
      url,
      createdAt: row.created_at,
      groupName: row.group_name || undefined,
      ...this.resolveIcon(row),
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

      // Fall back to icon.png alongside the source file
      const dir = dirname(filePath);
      const iconPath = join(dir, "icon.png");
      if (existsSync(iconPath)) {
        return { icon: `/artifacts/${basename(dir)}/icon.png`, iconStatus: "ready" };
      }
    } catch {}
    return {};
  }
}
