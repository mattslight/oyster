// Session tile (icons-view card). Extracted from Home/index.tsx.
import type { Session } from "../../data/sessions-api";
import type { Space } from "../../../../shared/types";
import type { PresenceInfo } from "../../hooks/useTerminalPresence";
import {
  AGENT_CLASS, AGENT_LETTERS,
  activeWriterChipFor, metaForSession, originDeviceChipFor, spaceLabelFor,
} from "./utils";

interface SessionTileProps {
  session: Session;
  spaces: Space[];
  showSpaceChip: boolean;
  /** Local device id, when known. Drives the cross-device chip. Null
   *  during the brief window before useMyDeviceId resolves — chip is
   *  suppressed during that window. */
  myDeviceId: string | null;
  livePresence?: PresenceInfo | undefined;
  onOpen?: (id: string) => void;
}

export function SessionTile({ session, spaces, showSpaceChip, myDeviceId, livePresence, onOpen }: SessionTileProps) {
  const spaceLabel = spaceLabelFor(session.spaceId, spaces);
  const hasTitle = !!session.title;
  const title = session.title ?? "Untitled";
  const remoteChip = originDeviceChipFor(session, myDeviceId);
  const activeChip = activeWriterChipFor(session, myDeviceId);
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
        {remoteChip ? (
          // Cross-device chip wins over the space chip when both would apply —
          // origin is a stronger signal than space membership for these cards.
          <span className="home-remote-chip" title={remoteChip.titleTooltip}>
            <span aria-hidden="true">↗</span> {remoteChip.label}
          </span>
        ) : (
          showSpaceChip && spaceLabel && (
            <span className="home-space-chip">{spaceLabel}</span>
          )
        )}
        {activeChip && (
          // Active-writer chip in the opposite corner so it doesn't clash with
          // origin/space. Visible whenever there's been a hand-off, including
          // back to this device.
          <span className="home-active-chip" title={activeChip.titleTooltip}>
            {activeChip.label}
          </span>
        )}
        <span className="home-agent-mark">{AGENT_LETTERS[session.agent]}</span>
        <span className={`home-status ${session.displayState}`} />
        {livePresence && (
          <span
            className={`tile-presence-dot${livePresence.state === "attached" ? " tpd--attached" : " tpd--running"}`}
            title={livePresence.state === "attached" ? "Open in terminal" : "Minimised"}
          />
        )}
      </div>
      <div className="home-tile-label" title={title}>
        {hasTitle ? title : <span className="session-untitled">{title}</span>}
      </div>
      <div className="home-tile-meta">{metaForSession(session)}</div>
    </div>
  );
}
