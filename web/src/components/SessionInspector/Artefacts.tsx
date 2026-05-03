// Artefacts — extracted from SessionInspector for navigability.
import type { SessionArtifactJoined } from "../../data/sessions-api";
import type { Artifact } from "../../data/artifacts-api";
import { KindThumb } from "../KindThumb";
import { formatRel } from "./utils";

const ROLE_PRIORITY = { create: 3, modify: 2, read: 1 } as const;

/**
 * Collapse repeated touches of the same artefact into one row, keeping the
 * highest-impact role (create > modify > read) and the most recent timestamp.
 * A long session may Read+Edit the same file many times; the user wants one
 * "this artefact was modified" row, not the full audit trail.
 */
function dedupeTouches(items: SessionArtifactJoined[]): SessionArtifactJoined[] {
  const byId = new Map<string, SessionArtifactJoined>();
  for (const item of items) {
    const existing = byId.get(item.artifact.id);
    if (!existing) {
      byId.set(item.artifact.id, item);
      continue;
    }
    const incomingPriority = ROLE_PRIORITY[item.role];
    const existingPriority = ROLE_PRIORITY[existing.role];
    if (incomingPriority > existingPriority) {
      byId.set(item.artifact.id, item);
    } else if (incomingPriority === existingPriority && item.whenAt > existing.whenAt) {
      byId.set(item.artifact.id, item);
    }
  }
  return Array.from(byId.values()).sort((a, b) => {
    const dp = ROLE_PRIORITY[b.role] - ROLE_PRIORITY[a.role];
    if (dp !== 0) return dp;
    return b.whenAt.localeCompare(a.whenAt);
  });
}

export function Artefacts({
  items, onOpenArtefact,
}: {
  items: SessionArtifactJoined[] | null;
  onOpenArtefact: (artefact: Artifact) => void;
}) {
  if (items === null) return <div className="inspector-empty">Loading artefacts…</div>;
  const deduped = dedupeTouches(items);
  if (deduped.length === 0) {
    return <div className="inspector-empty">No artefacts touched yet.</div>;
  }
  return (
    <>
      {deduped.map((item) => (
        <button
          type="button"
          key={item.artifact.id}
          className="link-row"
          onClick={() => onOpenArtefact(item.artifact)}
        >
          <KindThumb kind={item.artifact.artifactKind} />
          <div className="link-body">
            <div className="link-title">{item.artifact.label}</div>
            <div className="link-meta">
              <span className={`role-chip ${item.role}`}>{item.role}</span>
              <span>{formatRel(item.whenAt)}</span>
            </div>
          </div>
        </button>
      ))}
    </>
  );
}
