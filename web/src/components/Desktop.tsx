import type { Artifact } from "../data/mock-artifacts";
import { ArtifactIcon } from "./ArtifactIcon";

interface Props {
  artifacts: Artifact[];
  onArtifactClick: (artifact: Artifact) => void;
}

export function Desktop({ artifacts, onArtifactClick }: Props) {
  return (
    <div className="desktop">
      <div className="icon-grid">
        {artifacts.map((artifact, i) => (
          <ArtifactIcon
            key={artifact.id}
            artifact={artifact}
            index={i}
            onClick={() => onArtifactClick(artifact)}
          />
        ))}
      </div>
    </div>
  );
}
