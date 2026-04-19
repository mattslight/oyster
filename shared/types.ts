export const ARTIFACT_KINDS = [
  "app", "deck", "diagram", "map", "notes", "table", "wireframe",
] as const;

export type ArtifactKind = typeof ARTIFACT_KINDS[number];

export function shouldOpenFullscreen(kind: ArtifactKind): boolean {
  return kind === "deck" || kind === "app" || kind === "diagram";
}

export type ArtifactStatus =
  | "generating"
  | "offline"
  | "online"
  | "ready"
  | "starting";

export type IconStatus = "pending" | "generating" | "ready" | "failed";

export interface Artifact {
  id: string;
  label: string;
  artifactKind: ArtifactKind;
  spaceId: string;
  status: ArtifactStatus;
  runtimeKind: string;
  runtimeConfig: Record<string, unknown>;
  url: string;
  icon?: string;
  iconStatus?: IconStatus;
  createdAt: string;
  groupName?: string;
  pendingReveal?: boolean;
  /** First-party app bundled with Oyster (builtins/*). Read-only — cannot be renamed or archived from the UI. */
  builtin?: boolean;
  /** Third-party plugin installed via `oyster install <id>`. Removal means uninstall (delete folder), not archive. */
  plugin?: boolean;
  /** For plugin artifacts: the folder-name id under ~/.oyster/userland/ (e.g. "pomodoro"). Used by Uninstall since `id` is a UUID that doesn't map to a directory. */
  pluginId?: string;
}

export type ScanStatus = "none" | "scanning" | "complete" | "error";

export interface ScanResult {
  discovered: number;
  skipped: number;
  resurfaced: number;
  errors: string[];
  artifacts: Array<{ id: string; label: string; kind: string; sourceRef: string | null }>;
}

export interface Space {
  id: string;
  displayName: string;
  repoPath: string | null;
  color: string | null;
  parentId: string | null;
  scanStatus: ScanStatus;
  scanError: string | null;
  lastScannedAt: string | null;
  lastScanSummary: Omit<ScanResult, "artifacts"> | null;
  createdAt: string;
  updatedAt: string;
}
