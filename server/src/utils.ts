import type { ArtifactKind } from "../../shared/types.js";
import { extname } from "node:path";

export function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function inferKindFromPath(filePath: string): ArtifactKind {
  const lower = filePath.toLowerCase();
  if (lower.includes("dashboard") || lower.includes("diagram")) return "diagram";
  if (lower.includes("deck") || lower.includes("slide") || lower.includes("present")) return "deck";
  if (lower.includes("map") || lower.includes("mind")) return "map";
  if (lower.includes("note") || lower.includes("readme")) return "notes";
  if (lower.includes("table") || lower.includes("spreadsheet") || lower.includes("tracker")) return "table";
  const ext = extname(lower);
  if (ext === ".md") return "notes";
  if (ext === ".mmd" || ext === ".mermaid") return "diagram";
  return "app";
}
