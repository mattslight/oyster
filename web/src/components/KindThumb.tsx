import type { ArtifactKind } from "../../../shared/types";
import { typeConfig } from "./ArtifactIcon";

interface Props {
  kind: ArtifactKind;
  /** Outer square size in pixels. Default 32 (link-row thumb). Use 64 for the artefact-inspector header. */
  size?: number;
}

/**
 * Small kind-coloured glyph used in inspector link rows and the artefact
 * inspector header. Reads colour/icon path from ArtifactIcon's typeConfig
 * so the kind palette stays consistent with the desktop tile.
 */
export function KindThumb({ kind, size = 32 }: Props) {
  const config = typeConfig[kind] ?? typeConfig.app;
  const iconSize = Math.round(size * 0.5);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.18),
        background: config.gradient,
        color: config.color,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width={iconSize}
        height={iconSize}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={config.icon} />
      </svg>
    </div>
  );
}
