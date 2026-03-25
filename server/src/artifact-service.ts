import type { ArtifactStore, ArtifactRow } from "./artifact-store.js";
import type { Artifact, ArtifactKind, ArtifactStatus } from "../../shared/types.js";
import { isPortOpen, isStarting, clearStarting, getGeneratedArtifacts } from "./process-manager.js";

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

// ── Service ──

export class ArtifactService {
  constructor(private store: ArtifactStore) {}

  async getAllArtifacts(onArtifactRemoved?: (id: string, filePath: string) => void): Promise<Artifact[]> {
    const rows = this.store.getAll();
    const persisted = await Promise.all(rows.map((row) => this.rowToArtifact(row)));
    const generated = getGeneratedArtifacts(onArtifactRemoved);
    return [...persisted, ...generated];
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
    if (!row || row.runtime_kind !== "static_file") return undefined;
    const storage = parseJson(row.storage_config) as FilesystemStorageConfig;
    return storage.path;
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
    };
  }
}
