// Session row (table-view list item). Extracted from Home/index.tsx.
import type { Session } from "../../data/sessions-api";
import type { Space } from "../../../../shared/types";
import {
  AGENT_PIP_CLASS, activeWriterChipFor, formatRelative,
  originDeviceChipFor, spaceLabelFor,
} from "./utils";
import type { PresenceInfo } from "../../hooks/useTerminalPresence";

interface SessionRowProps {
  session: Session;
  spaces: Space[];
  /** Local device id; drives the cross-device chip. See SessionTile. */
  myDeviceId: string | null;
  /** Presence info from useTerminalPresence; undefined when no live terminal. */
  livePresence?: PresenceInfo;
  onOpen?: (id: string) => void;
  /** Focus an already-open terminal window for this session. */
  onTerminalFocus?: (terminalId: string) => void;
  /** Restore a minimised terminal window for this session. */
  onTerminalRestore?: (sessionId: string, terminalId: string) => void;
  /** Resume a non-live session (spawns `claude --resume <id>`). */
  onResume?: (sessionId: string) => void;
}

export function SessionRow({ session, spaces, myDeviceId, livePresence, onOpen, onTerminalFocus, onTerminalRestore, onResume }: SessionRowProps) {
  const spaceLabel = spaceLabelFor(session.spaceId, spaces);
  const time = formatRelative(session.lastEventAt) ?? "—";
  const hasTitle = !!session.title;
  const title = session.title ?? "Untitled";
  // Prefer the most specific label available: space > cwd basename for
  // orphan sessions. Always tooltip the full cwd so the user can identify
  // where the session was running.
  const cwdBasename = session.cwd ? session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? null : null;
  const projectLabel = spaceLabel ?? cwdBasename ?? "—";
  const remoteChip = originDeviceChipFor(session, myDeviceId);
  const activeChip = activeWriterChipFor(session, myDeviceId);
  const isManual = session.assignmentMode === "manual";
  const rowExtraClass = livePresence
    ? (livePresence.state === "attached" ? " sr--attached" : " sr--running")
    : "";
  const statusDotClass = livePresence
    ? (livePresence.state === "attached" ? "rd--attached" : "rd--running")
    : session.state;

  // Row click always opens the Session Inspector. The Connect chip (live
  // sessions) and Resume chip (non-live sessions) handle the terminal
  // restore / resume paths so the row's primary action stays predictable.
  const handleRowActivate = () => {
    if (onOpen) onOpen(session.id);
  };

  // Connect (live row): focus the open terminal or restore the minimised one.
  // Resume (non-live row): spawn claude --resume in this session's cwd.
  const handleConnect = () => {
    if (!livePresence) return;
    if (livePresence.state === "attached") onTerminalFocus?.(livePresence.terminalId);
    else onTerminalRestore?.(session.id, livePresence.terminalId);
  };
  const canResume = !livePresence && !!onResume;
  // Only render the Connect chip when we actually have the callback that
  // will handle this presence state. Otherwise clicking would silently
  // no-op via the ?. in handleConnect.
  const canConnect = livePresence
    ? (livePresence.state === "attached" ? !!onTerminalFocus : !!onTerminalRestore)
    : false;
  return (
    <div
      className={`home-row${rowExtraClass}`}
      onClick={handleRowActivate}
      onKeyDown={onOpen ? (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleRowActivate(); }
      } : undefined}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
    >
      <span className={`home-row-status ${statusDotClass}`} />
      <span className="home-row-space" title={session.cwd ?? undefined}>{projectLabel}</span>
      <span className="home-row-title">
        <span className="home-row-title-inner" title={title}>
          {remoteChip && (
            <span className="home-remote-chip" title={remoteChip.titleTooltip}>
              <span aria-hidden="true">↗</span> {remoteChip.label}
            </span>
          )}
          {activeChip && (
            <span className="home-active-chip" title={activeChip.titleTooltip}>
              {activeChip.label}
            </span>
          )}
          {isManual && (
            <span className="home-manual-chip" title="Pinned manually — Oyster's heuristic won't reassign this.">
              pinned
            </span>
          )}
          {hasTitle ? title : <span className="session-untitled">{title}</span>}
        </span>
        {livePresence && canConnect && (
          <button
            type="button"
            className="sl-chip sl-chip--connect"
            onClick={(e) => { e.stopPropagation(); handleConnect(); }}
            title={livePresence.state === "attached" ? "Bring the open terminal forward" : "Restore this minimised terminal"}
          >
            Connect
          </button>
        )}
        {canResume && (
          <button
            type="button"
            className="sl-chip sl-chip--resume"
            onClick={(e) => { e.stopPropagation(); onResume!(session.id); }}
            title="Start a new claude --resume in this session's folder"
          >
            Resume
          </button>
        )}
      </span>
      <span className={`home-row-agent ${AGENT_PIP_CLASS[session.agent]}`}>
        <span className="home-agent-pip" />
        {session.agent}
      </span>
      <span className="home-row-time">{time}</span>
    </div>
  );
}
