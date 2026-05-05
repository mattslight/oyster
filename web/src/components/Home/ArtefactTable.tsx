// Artefact table view. Extracted from Home/index.tsx.
import type { Space } from "../../../../shared/types";
import type { Desktop } from "../Desktop";
import { parseTimestamp } from "../../utils/parseTimestamp";
import { formatRelative } from "./utils";

interface ArtefactTableProps {
  artifacts: Parameters<typeof Desktop>[0]["artifacts"];
  spaces: Space[];
  onArtifactClick: Parameters<typeof Desktop>[0]["onArtifactClick"];
}

export function ArtefactTable({ artifacts, spaces, onArtifactClick }: ArtefactTableProps) {
  if (artifacts.length === 0) {
    return <div className="home-empty">No artefacts here yet.</div>;
  }
  const sorted = [...artifacts].sort((a, b) => {
    // Pinned-first (#387) — pinned artefacts always bubble to the top in
    // both icon and table views. Order within the pinned group is by pin
    // time DESC (newest pin first); unpinned rows then fall through to
    // the existing createdAt DESC sort.
    const ap = a.pinnedAt ?? 0;
    const bp = b.pinnedAt ?? 0;
    if (ap !== bp) return bp - ap;
    const ta = parseTimestamp(a.createdAt);
    const tb = parseTimestamp(b.createdAt);
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
  return (
    <div className="home-table-wrap">
      <div className="home-table">
        {sorted.map((art) => {
          const space = spaces.find((s) => s.id === art.spaceId);
          return (
            <div
              key={art.id}
              className="home-artefact-row"
              role="button"
              tabIndex={0}
              onClick={() => onArtifactClick(art)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onArtifactClick(art);
                }
              }}
            >
              <span className="home-artefact-row-title">{art.label}</span>
              <span className="home-artefact-row-space">{space?.displayName ?? art.spaceId}</span>
              <span className="home-artefact-row-kind">{art.artifactKind}</span>
              <span className="home-artefact-row-time">{formatRelative(art.createdAt) ?? "—"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
