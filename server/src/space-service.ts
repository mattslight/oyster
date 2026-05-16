import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import type { Ignore } from "ignore";
import ignore from "ignore";
import type { SpaceStore, SpaceRow } from "./space-store.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { ArtifactService } from "./artifact-service.js";
import type { SessionStore } from "./session-store.js";
import type { SpaceSyncService } from "./space-sync-service.js";
import type { Space } from "../../shared/types.js";
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

export class SpaceService {
  constructor(
    private spaceStore: SpaceStore,
    private artifactStore: ArtifactStore,
    _artifactService: ArtifactService,
    _sessionStore: SessionStore,
    private spaceSync?: SpaceSyncService,
  ) {
    void _artifactService; void _sessionStore;
  }

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
    this.spaceStore.markSyncDirty(id);
    void this.spaceSync?.pushOne(id);

    return rowToSpace(this.spaceStore.getById(id)!);
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
    this.spaceStore.markSyncDirty(id);
    void this.spaceSync?.pushOne(id);
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
    if (Object.keys(dbFields).length === 0) {
      // No fields to update — caller's intent was a no-op (e.g. updateSpace(id, {})
      // or all fields explicitly undefined). Don't mark dirty or push; doing so
      // would overwrite a peer's legitimate edit via LWW with no local intent.
      return rowToSpace(row);
    }
    this.spaceStore.update(id, dbFields);
    this.spaceStore.markSyncDirty(id);
    void this.spaceSync?.pushOne(id);
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
    // Soft-delete locally; cloud propagates the tombstone via pushDelete.
    // (pushDelete is fire-and-forget; the pending-delete sweep in the next
    // reconcile() retries on failure.)
    this.spaceStore.softDelete(id);
    void this.spaceSync?.pushDelete(id);
  }
}
