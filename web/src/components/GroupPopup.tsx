import { useEffect, useRef } from "react";
import type { Artifact } from "../data/artifacts-api";
import { ArtifactIcon } from "./ArtifactIcon";

interface Props {
  name: string;
  artifacts: Artifact[];
  onArtifactClick: (artifact: Artifact) => void;
  onArtifactStop?: (artifact: Artifact) => void;
  onClose: () => void;
}

export function GroupPopup({ name, artifacts, onArtifactClick, onArtifactStop, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function handleBackdropClick(e: React.MouseEvent) {
    if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
      onClose();
    }
  }

  return (
    <div className="group-popup-overlay" onClick={handleBackdropClick}>
      <div className="group-popup" ref={panelRef}>
        <div className="group-popup-header">{name}</div>
        <div className="group-popup-grid">
          {artifacts.map((artifact, i) => (
            <ArtifactIcon
              key={artifact.id}
              artifact={artifact}
              index={i}
              onClick={() => onArtifactClick(artifact)}
              onStop={onArtifactStop ? () => onArtifactStop(artifact) : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
