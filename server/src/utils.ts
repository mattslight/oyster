import type { ArtifactKind, ScanStatus } from "../../shared/types.js";
import { extname } from "node:path";

// ReadonlySet<string> lets .has() accept any string without casting.
// The `satisfies` on the array literal keeps the sets in sync with their union types at compile time.
const VALID_ARTIFACT_KINDS: ReadonlySet<string> = new Set(
  ["app", "deck", "diagram", "map", "notes", "table", "wireframe"] as const satisfies readonly ArtifactKind[],
);
const VALID_SCAN_STATUSES: ReadonlySet<string> = new Set(
  ["none", "scanning", "complete", "error"] as const satisfies readonly ScanStatus[],
);

export function isArtifactKind(value: string): value is ArtifactKind {
  return VALID_ARTIFACT_KINDS.has(value);
}

export function toArtifactKind(value: string): ArtifactKind {
  return isArtifactKind(value) ? value : "app";
}

function isScanStatus(value: string): value is ScanStatus {
  return VALID_SCAN_STATUSES.has(value);
}

export function toScanStatus(value: string): ScanStatus {
  return isScanStatus(value) ? value : "none";
}

export function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function inferKindFromPath(filePath: string): ArtifactKind {
  const lower = filePath.toLowerCase();
  if (lower.includes("dashboard") || lower.includes("diagram") || lower.includes("analysis") || lower.includes("chart")) return "diagram";
  if (lower.includes("deck") || lower.includes("slide") || lower.includes("present")) return "deck";
  if (lower.includes("map") || lower.includes("mind") || lower.includes("segment")) return "map";
  if (lower.includes("note") || lower.includes("readme")) return "notes";
  if (lower.includes("table") || lower.includes("spreadsheet") || lower.includes("tracker")) return "table";
  const ext = extname(lower);
  if (ext === ".md") return "notes";
  if (ext === ".mmd" || ext === ".mermaid") return "diagram";
  return "app";
}
