// Shared Home types + constants. Extracted from Home/index.tsx so
// sibling components (ProjectTileGrid, etc.) can import them directly.
import type { SessionState } from "../../data/sessions-api";

export type ViewMode = "icons" | "table";
export type StateFilter = SessionState | "live" | "all";
export type ArtefactSource = "all" | "manual" | "ai_generated" | "discovered";

// Sentinel for the Vault tile (artefacts with no source_id —
// natively-created via create_artifact, not from a linked folder).
export const VAULT = "__vault__";
