// Project tile grid: All / Vault / one tile per project / + Add.
// Renamed from "linked folder" framing — projects don't have a path; folder
// association is downstream via `.oyster/id` or claim_orphan.
import { useMemo } from "react";
import { Shield } from "lucide-react";
import type { Project } from "../../data/projects-api";
import { AttachFolderForm } from "./AttachFolderForm";
import { ProjectTile } from "./ProjectTile";
import { VAULT, type StateFilter } from "./types";

export function ProjectTileGrid({
  spaceId, projects, projectArtefactCounts, sessionCountsByProject,
  selectedProjectId, setSelectedProjectId,
  totalCounts, showAttachForm, setShowAttachForm, onProjectsChanged, onSpaceDelete,
  onLaunchClaude,
}: {
  spaceId: string;
  projects: Project[];
  // Sparse maps — projects with no artefacts / no live sessions have no
  // entry. Callsites use `?? 0` and pass the lookup into ProjectTile's
  // optional `sessionCounts?` prop.
  projectArtefactCounts: Partial<Record<string, number>>;
  sessionCountsByProject: Partial<Record<string, { active: number; waiting: number; disconnected: number }>>;
  selectedProjectId: string | null;
  setSelectedProjectId: (next: string | null) => void;
  totalCounts: Record<StateFilter, number>;
  showAttachForm: boolean;
  setShowAttachForm: (v: boolean) => void;
  onProjectsChanged: () => void;
  onSpaceDelete?: (spaceId: string) => Promise<void> | void;
  onLaunchClaude?: (projectId: string) => void;
}) {
  // Sort by artefact count desc — busiest projects first.
  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) =>
      (projectArtefactCounts[b.id] ?? 0) - (projectArtefactCounts[a.id] ?? 0)
    ),
    [projects, projectArtefactCounts],
  );
  const vaultCount = projectArtefactCounts[VAULT] ?? 0;

  function pickTile(id: string | null) {
    setSelectedProjectId(selectedProjectId === id ? null : id);
  }

  return (
    <div className="home-spaces-section home-projects-section">
      <div className="home-spaces-grid">
        <button
          type="button"
          className={`home-space-card${selectedProjectId === null ? " selected" : ""}`}
          onClick={() => pickTile(null)}
          title="All projects in this space"
        >
          <div className="home-space-card-name">All</div>
          <div className="home-space-card-counts">
            {totalCounts.active > 0 && <span className="signal"><span className="pip pip-green" />{totalCounts.active} active</span>}
            {totalCounts.waiting > 0 && <span className="signal"><span className="pip pip-amber" />{totalCounts.waiting} waiting</span>}
            {totalCounts.done > 0 && <span className="signal"><span className="pip pip-dim" />{totalCounts.done} done</span>}
            {totalCounts.all === 0 && <span className="signal signal-muted">no sessions yet</span>}
          </div>
        </button>

        {vaultCount > 0 && (
          <button
            type="button"
            className={`home-space-card home-project-tile--vault${selectedProjectId === VAULT ? " selected" : ""}`}
            onClick={() => pickTile(VAULT)}
            title="Native artefacts created in this space (not from a project)"
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

        {sortedProjects.map((p) => (
          <ProjectTile
            key={p.id}
            project={p}
            artefactCount={projectArtefactCounts[p.id] ?? 0}
            sessionCounts={sessionCountsByProject[p.id]}
            selected={selectedProjectId === p.id}
            onSelect={() => pickTile(p.id)}
            onChanged={onProjectsChanged}
            isLastProject={projects.length === 1}
            spaceTotalSessions={totalCounts.all}
            onSpaceDelete={onSpaceDelete}
            otherProjects={sortedProjects.filter((o) => o.id !== p.id)}
            onLaunchClaude={onLaunchClaude}
          />
        ))}

        <button
          type="button"
          className="home-space-card home-project-tile--add"
          onClick={() => setShowAttachForm(true)}
        >
          <div className="home-space-card-name">+ Add project</div>
          <div className="home-space-card-counts">
            <span className="signal signal-muted">claim a folder of sessions</span>
          </div>
        </button>
      </div>

      {showAttachForm && (
        <AttachFolderForm
          spaceId={spaceId}
          onAttached={() => {
            setShowAttachForm(false);
            onProjectsChanged();
          }}
          onCancel={() => setShowAttachForm(false)}
        />
      )}
    </div>
  );
}
