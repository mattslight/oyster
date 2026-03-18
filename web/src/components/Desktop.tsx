import type { Artifact } from "../data/artifacts-api";
import { ArtifactIcon } from "./ArtifactIcon";
import Aurora from "./reactbits/Aurora";

interface Props {
  artifacts: Artifact[];
  onArtifactClick: (artifact: Artifact) => void;
  onArtifactStop?: (artifact: Artifact) => void;
}

export function Desktop({ artifacts, onArtifactClick, onArtifactStop }: Props) {
  return (
    <div className="desktop">
      <div className="desktop-aurora">
        <Aurora
          colorStops={["#2a1f6b", "#7c6bff", "#1a1b2e"]}
          amplitude={1.2}
          blend={0.6}
          speed={0.5}
        />
      </div>
      <div className="icon-grid">
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
  );
}
