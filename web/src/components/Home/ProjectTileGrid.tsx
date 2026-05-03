// Project tile grid: All / Vault / one tile per linked folder / + Attach.
// Extracted from Home/index.tsx.
import { useMemo } from "react";
import { Shield } from "lucide-react";
import type { SpaceSource } from "../../data/spaces-api";
import { AttachFolderForm } from "./AttachFolderForm";
import { ProjectTile } from "./ProjectTile";
import { VAULT, type StateFilter } from "./types";

// Project tile grid — same visual primitive as Home's space cards.
// Renders one tile per attached folder (plus an "All" meta-tile, a
// Vault tile for native artefacts, and a "+ Attach" tile). The
// selected tile is exclusive: clicking another switches scope, clicking
// the selected tile snaps back to All. Detach lives in a hover ⋯ menu
// on linked tiles only — Vault can't be detached.
export function ProjectTileGrid({
  spaceId, spaceDisplayName, sources, folderArtefactCounts, sessionCountsBySource,
  selectedFolderId, setSelectedFolderId,
  totalCounts, showAttachForm, setShowAttachForm, onSourcesChanged, onSpaceDelete,
}: {
  spaceId: string;
  spaceDisplayName: string;
  sources: SpaceSource[];
  folderArtefactCounts: Record<string, number>;
  sessionCountsBySource: Record<string, { active: number; waiting: number; disconnected: number }>;
  selectedFolderId: string | null;
  setSelectedFolderId: (next: string | null) => void;
  totalCounts: Record<StateFilter, number>;
  showAttachForm: boolean;
  setShowAttachForm: (v: boolean) => void;
  onSourcesChanged: () => void;
  onSpaceDelete?: (spaceId: string) => Promise<void> | void;
}) {
  // Sort linked tiles by tile count desc — busiest folders first.
  const sortedSources = useMemo(
    () => [...sources].sort((a, b) =>
      (folderArtefactCounts[b.id] ?? 0) - (folderArtefactCounts[a.id] ?? 0)
    ),
    [sources, folderArtefactCounts],
  );
  const vaultCount = folderArtefactCounts[VAULT] ?? 0;

  function pickTile(id: string | null) {
    setSelectedFolderId(selectedFolderId === id ? null : id);
  }

  return (
    <div className="home-spaces-section home-projects-section">
      <div className="home-spaces-grid">
        <button
          type="button"
          className={`home-space-card${selectedFolderId === null ? " selected" : ""}`}
          onClick={() => pickTile(null)}
          title="All projects in this space"
        >
          <div className="home-space-card-name">All</div>
          <div className="home-space-card-counts">
            {totalCounts.active > 0 && <span className="signal"><span className="pip pip-green" />{totalCounts.active} active</span>}
            {totalCounts.waiting > 0 && <span className="signal"><span className="pip pip-amber" />{totalCounts.waiting} waiting</span>}
            {totalCounts.disconnected > 0 && <span className="signal"><span className="pip pip-red" />{totalCounts.disconnected} disconnected</span>}
            {totalCounts.done > 0 && <span className="signal"><span className="pip pip-dim" />{totalCounts.done} done</span>}
            {totalCounts.all === 0 && <span className="signal signal-muted">no sessions yet</span>}
          </div>
        </button>

        {vaultCount > 0 && (
          <button
            type="button"
            className={`home-space-card home-project-tile--vault${selectedFolderId === VAULT ? " selected" : ""}`}
            onClick={() => pickTile(VAULT)}
            title="Native artefacts created in this space (not from a linked folder)"
          >
            <div className="home-space-card-name">
              <Shield size={12} strokeWidth={2} fill="currentColor" aria-hidden="true" className="home-project-glyph" />
              <span>{spaceId}</span>
              <span className="home-project-tag">vault</span>
            </div>
            <div className="home-space-card-counts">
              <span className="signal"><span className="pip pip-dim" />{vaultCount} {vaultCount === 1 ? "artefact" : "artefacts"}</span>
            </div>
          </button>
        )}

        {sortedSources.map((s) => (
          <ProjectTile
            key={s.id}
            source={s}
            artefactCount={folderArtefactCounts[s.id] ?? 0}
            sessionCounts={sessionCountsBySource[s.id]}
            selected={selectedFolderId === s.id}
            onSelect={() => pickTile(s.id)}
            onSourcesChanged={onSourcesChanged}
            isLastSource={sources.length === 1}
            spaceDisplayName={spaceDisplayName}
            spaceTotalSessions={totalCounts.all}
            onSpaceDelete={onSpaceDelete}
          />
        ))}

        <button
          type="button"
          className="home-space-card home-project-tile--add"
          onClick={() => setShowAttachForm(true)}
        >
          <div className="home-space-card-name">+ Attach folder</div>
          <div className="home-space-card-counts">
            <span className="signal signal-muted">link a repo or folder</span>
          </div>
        </button>
      </div>

      {showAttachForm && (
        <AttachFolderForm
          spaceId={spaceId}
          onAttached={() => {
            setShowAttachForm(false);
            onSourcesChanged();
          }}
          onCancel={() => setShowAttachForm(false)}
        />
      )}
    </div>
  );
}
