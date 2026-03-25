import { useMemo } from "react";
import type { Artifact } from "../data/artifacts-api";
import { ArtifactIcon } from "./ArtifactIcon";
import { GroupIcon } from "./GroupIcon";
import Grainient from "./reactbits/Grainient";

interface Props {
  artifacts: Artifact[];
  onArtifactClick: (artifact: Artifact) => void;
  onArtifactStop?: (artifact: Artifact) => void;
  onGroupClick: (groupName: string) => void;
}

export function Desktop({ artifacts, onArtifactClick, onArtifactStop, onGroupClick }: Props) {
  const { groups, ungrouped } = useMemo(() => {
    const groups: Record<string, Artifact[]> = {};
    const ungrouped: Artifact[] = [];
    for (const a of artifacts) {
      if (a.groupName) {
        (groups[a.groupName] ??= []).push(a);
      } else {
        ungrouped.push(a);
      }
    }
    return { groups, ungrouped };
  }, [artifacts]);

  const sortedGroupNames = Object.keys(groups).sort();
  let idx = 0;

  return (
    <div className="desktop">
      <div className="desktop-bg">
        <Grainient
          color1="#07060f"
          color2="#7c6bff"
          color3="#5227FF"
          timeSpeed={0.15}
          colorBalance={0}
          warpStrength={2}
          warpFrequency={6.5}
          warpSpeed={2}
          warpAmplitude={20}
          blendAngle={0}
          blendSoftness={0.05}
          rotationAmount={500}
          noiseScale={2}
          grainAmount={0.15}
          grainScale={2}
          grainAnimated={false}
          contrast={1.2}
          gamma={0.8}
          saturation={0.7}
          centerX={0}
          centerY={0}
          zoom={1}
        />
      </div>
      <div className="icon-grid">
        {sortedGroupNames.map((name) => {
          const i = idx++;
          return (
            <GroupIcon
              key={`group:${name}`}
              name={name}
              artifacts={groups[name]}
              index={i}
              onClick={() => onGroupClick(name)}
            />
          );
        })}
        {ungrouped.map((artifact) => {
          const i = idx++;
          return (
            <ArtifactIcon
              key={artifact.id}
              artifact={artifact}
              index={i}
              onClick={() => onArtifactClick(artifact)}
              onStop={onArtifactStop ? () => onArtifactStop(artifact) : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}
