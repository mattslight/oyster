// Single linked-folder tile in the Project tile grid. Extracted from
// Home/index.tsx.
import { useEffect, useState } from "react";
import type { SpaceSource } from "../../data/spaces-api";
import { removeSpaceSource } from "../../data/spaces-api";
import { ConfirmModal } from "../ConfirmModal";

export function ProjectTile({
  source, artefactCount, sessionCounts, selected, onSelect, onSourcesChanged,
  isLastSource, spaceDisplayName, spaceTotalSessions, onSpaceDelete,
}: {
  source: SpaceSource;
  artefactCount: number;
  sessionCounts?: { active: number; waiting: number; disconnected: number };
  selected: boolean;
  onSelect: () => void;
  onSourcesChanged: () => void;
  /** True when this is the only source in the space — removing it collapses the space. */
  isLastSource: boolean;
  spaceDisplayName: string;
  spaceTotalSessions: number;
  onSpaceDelete?: (spaceId: string) => Promise<void> | void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Separator-agnostic so Windows paths (`C:\Users\...`) display correctly too.
  const basename = source.path.split(/[\\/]/).filter(Boolean).pop() ?? source.path;
  // Removing the only folder from a real space implicitly demotes the space:
  // we soft-delete the source then ask App to delete the (now empty) space.
  // Cascade returns sessions to Elsewhere via sessions.space_id ON DELETE SET NULL.
  const willCollapseSpace = isLastSource && Boolean(onSpaceDelete);

  // Close menu on outside click — same pattern as space-card menus.
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest(".home-project-tile-menu, .home-project-tile-more")) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [menuOpen]);

  async function performRemove() {
    setBusy(true);
    try {
      await removeSpaceSource(source.space_id, source.id);
      if (willCollapseSpace) {
        await onSpaceDelete!(source.space_id);
      }
      onSourcesChanged();
      setConfirmOpen(false);
    } catch (err) {
      alert(`Couldn't remove: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const sessionPhrase = spaceTotalSessions === 1 ? "1 session" : `${spaceTotalSessions} sessions`;

  return (
    <>
      <div className={`home-space-card home-project-tile${selected ? " selected" : ""}`}>
        <button
          type="button"
          className="home-project-tile-body"
          onClick={onSelect}
          title={source.path}
        >
          <div className="home-space-card-name">{basename}</div>
          <div className="home-space-card-counts">
            {sessionCounts && sessionCounts.active > 0 && <span className="signal"><span className="pip pip-green" />{sessionCounts.active} active</span>}
            {sessionCounts && sessionCounts.waiting > 0 && <span className="signal"><span className="pip pip-amber" />{sessionCounts.waiting} waiting</span>}
            {sessionCounts && sessionCounts.disconnected > 0 && <span className="signal"><span className="pip pip-red" />{sessionCounts.disconnected} disconnected</span>}
            <span className="signal"><span className="pip pip-dim" />{artefactCount} {artefactCount === 1 ? "artefact" : "artefacts"}</span>
          </div>
        </button>
        <button
          type="button"
          className={`home-project-tile-more${menuOpen ? " open" : ""}`}
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          aria-label="Folder actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="home-project-tile-menu" role="menu">
            <div className="home-project-tile-menu-path">{source.path}</div>
            <div className="home-project-tile-menu-divider" />
            <button
              type="button"
              className="home-project-tile-menu-item danger"
              onClick={() => { setMenuOpen(false); setConfirmOpen(true); }}
            >
              Remove folder…
            </button>
          </div>
        )}
      </div>
      <ConfirmModal
        open={confirmOpen}
        title={willCollapseSpace ? `Remove "${basename}" and delete ${spaceDisplayName}?` : `Remove "${basename}"?`}
        body={
          <>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>
              {source.path}
            </div>
            {willCollapseSpace ? (
              <>
                This is the only folder in <strong>{spaceDisplayName}</strong>.
                Removing it will delete the space, hide its artefacts, and send {sessionPhrase} back to Elsewhere.
              </>
            ) : (
              <>
                Its artefacts will be hidden. Sessions stay in <strong>{spaceDisplayName}</strong>.
                Reattach the same path to restore them.
              </>
            )}
          </>
        }
        confirmLabel={busy ? (willCollapseSpace ? "Deleting…" : "Removing…") : (willCollapseSpace ? "Remove and delete" : "Remove")}
        destructive
        onConfirm={performRemove}
        onCancel={() => !busy && setConfirmOpen(false)}
      />
    </>
  );
}
