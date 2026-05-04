// Shared Home types + constants. Extracted from Home/index.tsx so
// sibling components (ProjectTileGrid, etc.) can import them directly.
import type { SessionState } from "../../data/sessions-api";

export type ViewMode = "icons" | "table";
export type StateFilter = SessionState | "live" | "all";
// "published" is a *status*, not an origin — but it joins the same radio group on Home so users
// only deal with one filter dimension. The purple pip in the JSX is the visual cue that
// acknowledges the semantic mismatch; the pill also stays visible at 0 (origin pills hide at 0)
// because it doubles as a discoverability surface. Renaming the type to e.g. ArtefactFilter
// touches more files than the change justifies; revisit if more status filters land.
export type ArtefactSource = "all" | "manual" | "ai_generated" | "discovered" | "published";

// Sentinel for the Vault tile (artefacts with no source_id —
// natively-created via create_artifact, not from a linked folder).
export const VAULT = "__vault__";
