// Shared Home types + constants. Extracted from Home/index.tsx so
// sibling components (ProjectTileGrid, etc.) can import them directly.
import type { SessionState } from "../../data/sessions-api";

export type ViewMode = "icons" | "table";
export type StateFilter = SessionState | "live" | "all";
// "published" and "pinned" are *statuses*, not origins — but they join the same radio
// group on Home so users only deal with one filter dimension. The coloured pips in the
// JSX are the visual cue that acknowledges the semantic mismatch; both pills stay visible
// at 0 (origin pills hide at 0) because they double as discoverability surfaces.
// Renaming the type to e.g. ArtefactFilter touches more files than the change justifies.
export type ArtefactSource = "all" | "manual" | "ai_generated" | "discovered" | "published" | "pinned";

// Sentinel for the Vault tile (artefacts with no source_id —
// natively-created via create_artifact, not from a linked folder).
export const VAULT = "__vault__";
