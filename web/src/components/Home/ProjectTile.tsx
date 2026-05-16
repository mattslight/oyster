// Single project tile in a space view. Two actions: rename + delete.
// Projects don't have a path field — identity lives in `.oyster/id` inside
// the folder, so renames + moves are invisible to Oyster.
import { useEffect, useState } from "react";
import { GitBranch } from "lucide-react";
import type { Project } from "../../data/projects-api";
import { renameProject, deleteProject, absorbProject } from "../../data/projects-api";
import { ConfirmModal } from "../ConfirmModal";
import { PromptModal } from "../PromptModal";

export function ProjectTile({
  project, artefactCount, sessionCounts, selected, onSelect, onChanged,
  isLastProject, spaceTotalSessions, onSpaceDelete, otherProjects,
}: {
  project: Project;
  artefactCount: number;
  sessionCounts?: { active: number; waiting: number; disconnected: number };
  selected: boolean;
  onSelect: () => void;
  onChanged: () => void;
  /** True when this is the only project in the space — deleting it collapses the space. */
  isLastProject: boolean;
  spaceTotalSessions: number;
  onSpaceDelete?: (spaceId: string) => Promise<void> | void;
  /** Other projects in the same space — populates the "Merge into…" picker. */
  otherProjects: Project[];
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [mergePickerOpen, setMergePickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Removing the only project from a real space implicitly demotes the space.
  const willCollapseSpace = isLastProject && Boolean(onSpaceDelete);

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

  async function performDelete() {
    setBusy(true);
    try {
      await deleteProject(project.id);
      if (willCollapseSpace) await onSpaceDelete!(project.spaceId);
      onChanged();
      setConfirmOpen(false);
    } catch (err) {
      alert(`Couldn't delete: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function performMerge(intoId: string) {
    setBusy(true);
    try {
      await absorbProject(intoId, project.id);
      onChanged();
      setMergePickerOpen(false);
    } catch (err) {
      alert(`Couldn't merge: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function performRename(newName: string) {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === project.name) { setRenameOpen(false); return; }
    setBusy(true);
    try {
      await renameProject(project.id, trimmed);
      onChanged();
      setRenameOpen(false);
    } catch (err) {
      alert(`Couldn't rename: ${err instanceof Error ? err.message : String(err)}`);
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
          title={project.name}
        >
          <div
            className="home-space-card-name"
            style={{ display: "flex", alignItems: "flex-start", gap: 5 }}
          >
            {project.isGitRepo && (
              <GitBranch
                size={11}
                aria-label="git repository"
                style={{ marginTop: 4, flex: "0 0 auto", opacity: 0.55 }}
              />
            )}
            <span style={{ minWidth: 0, wordBreak: "break-word" }}>{project.name}</span>
          </div>
          <div className="home-space-card-counts">
            {sessionCounts && sessionCounts.active > 0 && <span className="signal"><span className="pip pip-green" />{sessionCounts.active} active</span>}
            {sessionCounts && sessionCounts.waiting > 0 && <span className="signal"><span className="pip pip-amber" />{sessionCounts.waiting} waiting</span>}
            {sessionCounts && sessionCounts.disconnected > 0 && <span className="signal"><span className="pip pip-red" />{sessionCounts.disconnected} disconnected</span>}
            <span className="signal"><span className="pip pip-dim" />{artefactCount} {artefactCount === 1 ? "artefact" : "artefacts"}</span>
            {project.hasLivePath === false && (
              <span
                className="signal"
                title={project.recentPath ? `Folder missing: ${project.recentPath}` : "no path cached"}
                style={{ color: "var(--home-amber)" }}
              >
                <span className="pip pip-amber" />no folder
              </span>
            )}
          </div>
        </button>
        <button
          type="button"
          className={`home-project-tile-more${menuOpen ? " open" : ""}`}
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          aria-label="Project actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          ⋯
        </button>
        {menuOpen && !mergePickerOpen && (
          <div className="home-project-tile-menu" role="menu">
            <button
              type="button"
              className="home-project-tile-menu-item"
              onClick={() => { setRenameOpen(true); setMenuOpen(false); }}
            >
              Rename…
            </button>
            {otherProjects.length > 0 && (
              <button
                type="button"
                className="home-project-tile-menu-item"
                onClick={() => setMergePickerOpen(true)}
                title="Move sessions, artefacts and the .oyster/id marker into another project."
              >
                Merge into…
              </button>
            )}
            <button
              type="button"
              className="home-project-tile-menu-item danger"
              onClick={() => { setMenuOpen(false); setConfirmOpen(true); }}
            >
              Delete project…
            </button>
          </div>
        )}
        {menuOpen && mergePickerOpen && (
          <div className="home-project-tile-menu" role="menu">
            <div className="home-project-tile-menu-header" style={{ padding: "8px 12px 4px", fontSize: 11, color: "var(--text-dim)" }}>
              Merge <strong>{project.name}</strong> into:
            </div>
            {otherProjects.map((target) => (
              <button
                key={target.id}
                type="button"
                className="home-project-tile-menu-item"
                disabled={busy}
                onClick={() => performMerge(target.id)}
              >
                {target.name}
                {target.hasLivePath === false && (
                  <span style={{ opacity: 0.5, marginLeft: 6 }}>(no folder)</span>
                )}
              </button>
            ))}
            <button
              type="button"
              className="home-project-tile-menu-item"
              disabled={busy}
              onClick={() => setMergePickerOpen(false)}
              style={{ opacity: 0.7 }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
      <PromptModal
        open={renameOpen}
        title={`Rename "${project.name}"`}
        initialValue={project.name}
        placeholder="Project name"
        confirmLabel={busy ? "Renaming…" : "Rename"}
        onSubmit={performRename}
        onCancel={() => !busy && setRenameOpen(false)}
      />
      <ConfirmModal
        open={confirmOpen}
        title={willCollapseSpace
          ? `Delete "${project.name}" and the space?`
          : `Delete "${project.name}"?`}
        body={willCollapseSpace ? (
          <>This is the only project in this space. Deleting it removes the space too; {sessionPhrase} fall back to Everything else.</>
        ) : (
          <>Sessions and artefacts attributed to this project become orphan but stay in the space. Reattach later by creating a new project and using "Claim folder".</>
        )}
        confirmLabel={busy ? "Deleting…" : "Delete"}
        destructive
        onConfirm={performDelete}
        onCancel={() => !busy && setConfirmOpen(false)}
      />
    </>
  );
}
