import { useEffect, useState, useRef } from "react";
import { fetchSessionsForArtifact } from "../data/artifacts-api";
import type { SessionJoinedForArtifact } from "../data/sessions-api";
import type { Artifact } from "../../../shared/types";
import { KindThumb } from "./KindThumb";
import type { ActivePanel } from "./InspectorPanel";

interface Props {
  artifact: Artifact;
  onSwitchTo: (next: ActivePanel) => void;
  onClose: () => void;
  onOpen: (artifact: Artifact) => void;
}

export function ArtefactInspector({ artifact, onSwitchTo, onClose, onOpen }: Props) {
  const [sessions, setSessions] = useState<SessionJoinedForArtifact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    const id = ++reqId.current;
    setSessions(null);
    setError(null);
    const ac = new AbortController();
    fetchSessionsForArtifact(artifact.id, ac.signal)
      .then((rows) => {
        if (id !== reqId.current) return;
        setSessions(rows);
      })
      .catch((err) => {
        if (id !== reqId.current || ac.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => ac.abort();
  }, [artifact.id]);

  function copyId() {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(artifact.id).then(() => {
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 1500);
    });
  }

  return (
    <>
      <header className="inspector-header">
        <div className="inspector-meta">
          {artifact.spaceId && <span className="space">{artifact.spaceId}</span>}
          {artifact.spaceId && <span>·</span>}
          <span>{artifact.artifactKind}</span>
          <span className="close" onClick={onClose}>✕</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 12 }}>
          <KindThumb kind={artifact.artifactKind} size={64} />
          <div style={{ minWidth: 0 }}>
            <div className="inspector-title">{artifact.label}</div>
            <div className="inspector-sub">
              {artifact.id}
              {artifact.sourceLabel && ` · ${artifact.sourceLabel}`}
            </div>
          </div>
        </div>
      </header>
      <div className="inspector-body">
        <div className="inspector-section-label" style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--accent-bright)", marginBottom: 12 }}>
          Sessions that touched this
        </div>
        {error && <div className="inspector-error">Couldn't load sessions: {error}</div>}
        {!error && sessions === null && <div className="inspector-empty">Loading…</div>}
        {!error && sessions !== null && sessions.length === 0 && (
          <div className="inspector-empty">No sessions have touched this artefact.</div>
        )}
        {!error && sessions && sessions.length > 0 && sessions.map((row) => (
          <div
            key={row.id}
            className="link-row"
            onClick={() => onSwitchTo({ kind: "session", id: row.session.id })}
          >
            <div className="link-thumb">{row.session.agent[0].toUpperCase()}</div>
            <div className="link-body">
              <div className="link-title">{row.session.title ?? "(no title)"}</div>
              <div className="link-meta">
                <span className={`role-chip ${row.role}`}>{row.role}</span>
                <span>{row.session.agent}</span>
                <span>{formatRel(row.whenAt)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
      <footer className="inspector-footer">
        <button type="button" className="btn primary" onClick={() => onOpen(artifact)}>
          Open
        </button>
        <button type="button" className="btn" onClick={copyId}>
          {copiedId ? "Copied!" : "Copy artefact ID"}
        </button>
      </footer>
    </>
  );
}

function formatRel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
