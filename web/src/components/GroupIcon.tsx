import type { Artifact } from "../data/artifacts-api";
import { typeConfig } from "./ArtifactIcon";

interface Props {
  name: string;
  artifacts: Artifact[];
  index: number;
  onClick: () => void;
}

export function GroupIcon({ name, artifacts, index, onClick }: Props) {
  // Take first 4 artifacts for the 2x2 preview
  const previews = artifacts.slice(0, 4);

  return (
    <button
      className="artifact-icon"
      style={{ animationDelay: `${index * 0.05 + 0.05}s` }}
      onClick={onClick}
    >
      <div className="group-thumb">
        <div className="group-grid">
          {[0, 1, 2, 3].map((i) => {
            const artifact = previews[i];
            if (!artifact) {
              return <div key={i} className="group-cell group-cell-empty" />;
            }
            const config = typeConfig[artifact.artifactKind] || typeConfig.app;
            return (
              <div
                key={artifact.id}
                className="group-cell"
                style={{ background: config.gradient }}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={config.color}
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d={config.icon} />
                </svg>
              </div>
            );
          })}
        </div>
        {artifacts.length > 4 && (
          <span className="group-count">+{artifacts.length - 4}</span>
        )}
      </div>
      <span className="icon-label">{name}</span>
    </button>
  );
}
