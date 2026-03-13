import type { Artifact } from "../data/mock-artifacts";

const typeConfig: Record<
  Artifact["type"],
  { gradient: string; color: string; ext: string; icon: string }
> = {
  wireframe: {
    gradient: "linear-gradient(135deg, #2d2f52, #353764)",
    color: "#818cf8",
    ext: "wireframe",
    icon: "M3 3h18v18H3zM3 9h18M9 21V9",
  },
  deck: {
    gradient: "linear-gradient(135deg, #2d2f52, #353764)",
    color: "#a78bfa",
    ext: "deck",
    icon: "M2 3h20v14H2zM8 21h8M12 17v4",
  },
  map: {
    gradient: "linear-gradient(135deg, #1e3a2f, #243f34)",
    color: "#4ade80",
    ext: "map",
    icon: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  },
  notes: {
    gradient: "linear-gradient(135deg, #1e3a2f, #243f34)",
    color: "#4ade80",
    ext: "notes",
    icon: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8",
  },
  app: {
    gradient: "linear-gradient(135deg, #1e2d4a, #253a5c)",
    color: "#60a5fa",
    ext: "app",
    icon: "M16 18l6-6-6-6M8 6l-6 6 6 6",
  },
  diagram: {
    gradient: "linear-gradient(135deg, #3a2d1e, #4a3a24)",
    color: "#fbbf24",
    ext: "diagram",
    icon: "M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4",
  },
};

interface Props {
  artifact: Artifact;
  index: number;
  onClick: () => void;
}

export function ArtifactIcon({ artifact, index, onClick }: Props) {
  const config = typeConfig[artifact.type];

  return (
    <button
      className={`artifact-icon ${artifact.status === "generating" ? "generating" : ""}`}
      style={{ animationDelay: `${index * 0.05 + 0.05}s` }}
      onClick={onClick}
    >
      <div className="icon-thumb" style={{ background: config.gradient }}>
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
        <span className="file-ext">{config.ext}</span>
      </div>
      <span className="icon-label">{artifact.name}</span>
    </button>
  );
}
