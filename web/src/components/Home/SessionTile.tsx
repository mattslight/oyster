// Session tile (icons-view card). Extracted from Home/index.tsx.
import type { Session } from "../../data/sessions-api";
import type { Space } from "../../../../shared/types";
import { AGENT_CLASS, AGENT_LETTERS, metaForSession, spaceLabelFor } from "./utils";

interface SessionTileProps {
  session: Session;
  spaces: Space[];
  showSpaceChip: boolean;
  onOpen?: (id: string) => void;
}

export function SessionTile({ session, spaces, showSpaceChip, onOpen }: SessionTileProps) {
  const spaceLabel = spaceLabelFor(session.spaceId, spaces);
  const title = session.title ?? "(no title yet)";
  return (
    <div
      className="home-tile"
      onClick={() => onOpen?.(session.id)}
      onKeyDown={onOpen ? (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(session.id); }
      } : undefined}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
    >
      <div className={`home-thumb ${AGENT_CLASS[session.agent]}`}>
        {showSpaceChip && spaceLabel && (
          <span className="home-space-chip">{spaceLabel}</span>
        )}
        <span className="home-agent-mark">{AGENT_LETTERS[session.agent]}</span>
        <span className={`home-status ${session.state}`} />
      </div>
      <div className="home-tile-label" title={title}>{title}</div>
      <div className="home-tile-meta">{metaForSession(session)}</div>
    </div>
  );
}
