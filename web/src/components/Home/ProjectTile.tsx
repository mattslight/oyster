// Single linked-folder tile in the Project tile grid. Extracted from
// Home/index.tsx.
import { useEffect, useState } from "react";
import type { SpaceSource } from "../../data/spaces-api";
import {
  removeSpaceSource,
  updateSpaceSource,
  consolidateSpaceSource,
  WouldConsolidateError,
  type ConsolidateTarget,
} from "../../data/spaces-api";
import { ConfirmModal } from "../ConfirmModal";
import { PromptModal } from "../PromptModal";

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
  const [pathPromptOpen, setPathPromptOpen] = useState(false);
  const [consolidateOffer, setConsolidateOffer] = useState<{
    target: ConsolidateTarget;
    moves: { sessionCount: number; artefactCount: number };
    sameSpace: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  // Separator-agnostic so Windows paths (`C:\Users\...`) display correctly too.
  const basename = source.path.split(/[\\/]/).filter(Boolean).pop() ?? source.path;
  const targetBasename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  function moveSummary(m: { sessionCount: number; artefactCount: number }) {
    const parts: string[] = [];
    if (m.sessionCount > 0) parts.push(`${m.sessionCount} ${m.sessionCount === 1 ? "session" : "sessions"}`);
    if (m.artefactCount > 0) parts.push(`${m.artefactCount} ${m.artefactCount === 1 ? "artefact" : "artefacts"}`);
    return parts.join(" and ") || "Nothing";
  }
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

  async function performPathUpdate(newPath: string) {
    const trimmed = newPath.trim();
    if (!trimmed || trimmed === source.path) {
      setPathPromptOpen(false);
      return;
    }
    setBusy(true);
    try {
      await updateSpaceSource(source.space_id, source.id, { path: trimmed });
      onSourcesChanged();
      setPathPromptOpen(false);
    } catch (err) {
      if (err instanceof WouldConsolidateError) {
        // The typed path is already attached to another active source.
        // Offer to merge this folder into that one instead of throwing
        // a raw error at the user.
        setPathPromptOpen(false);
        setConsolidateOffer({ target: err.target, moves: err.moves, sameSpace: err.sameSpace });
      } else {
        alert(`Couldn't update folder: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function performConsolidate() {
    if (!consolidateOffer) return;
    setBusy(true);
    try {
      await consolidateSpaceSource(source.space_id, source.id, consolidateOffer.target.id);
      onSourcesChanged();
      setConsolidateOffer(null);
    } catch (err) {
      alert(`Couldn't merge folders: ${err instanceof Error ? err.message : String(err)}`);
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
            {source.pathExists === false && (
              <span className="signal signal-warning" title="Folder not found at this path. Update or detach.">
                <span className="pip pip-amber" /> Path missing
              </span>
            )}
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
              className="home-project-tile-menu-item"
              onClick={() => { setMenuOpen(false); setPathPromptOpen(true); }}
            >
              Update folder location…
            </button>
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
        open={consolidateOffer !== null}
        title={consolidateOffer
          ? consolidateOffer.sameSpace
            ? `Merge "${basename}" into "${consolidateOffer.target.label ?? targetBasename(consolidateOffer.target.path)}"?`
            : `Path is already attached in another space`
          : ""
        }
        body={consolidateOffer ? (
          consolidateOffer.sameSpace ? (
            <>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>
                {consolidateOffer.target.path}
              </div>
              {consolidateOffer.moves.sessionCount + consolidateOffer.moves.artefactCount > 0 ? (
                <>
                  {moveSummary(consolidateOffer.moves)} will move from <strong>{basename}</strong> to{" "}
                  <strong>{consolidateOffer.target.label ?? targetBasename(consolidateOffer.target.path)}</strong>,
                  and <strong>{basename}</strong> will be removed.
                </>
              ) : (
                <>
                  Nothing is currently bound to <strong>{basename}</strong>, so the merge will just remove this tile and leave the
                  existing <strong>{consolidateOffer.target.label ?? targetBasename(consolidateOffer.target.path)}</strong> in place.
                </>
              )}
            </>
          ) : (
            <>
              That path is attached to a different space. Cross-space merge isn't supported — detach it there first if you really want to consolidate.
            </>
          )
        ) : null}
        confirmLabel={busy ? "Merging…" : consolidateOffer?.sameSpace ? "Merge" : "OK"}
        destructive={Boolean(consolidateOffer?.sameSpace)}
        onConfirm={consolidateOffer?.sameSpace ? performConsolidate : () => setConsolidateOffer(null)}
        onCancel={() => !busy && setConsolidateOffer(null)}
      />
      <PromptModal
        open={pathPromptOpen}
        title={`Update folder location for "${basename}"`}
        body={
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
            Point this source at a new absolute path. Existing sessions stay bound to this source — the change is metadata only. The path doesn't need to exist right now (useful for unmounted drives).
          </div>
        }
        initialValue={source.path}
        placeholder="/absolute/path/to/folder"
        confirmLabel={busy ? "Updating…" : "Update"}
        onSubmit={performPathUpdate}
        onCancel={() => !busy && setPathPromptOpen(false)}
      />
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
