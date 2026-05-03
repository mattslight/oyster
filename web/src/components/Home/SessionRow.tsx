// Session row (table-view list item). Extracted from Home/index.tsx.
import type { Session } from "../../data/sessions-api";
import type { Space } from "../../../../shared/types";
import { AGENT_PIP_CLASS, formatRelative, spaceLabelFor } from "./utils";

interface SessionRowProps {
  session: Session;
  spaces: Space[];
  onOpen?: (id: string) => void;
}

export function SessionRow({ session, spaces, onOpen }: SessionRowProps) {
  const spaceLabel = spaceLabelFor(session.spaceId, spaces);
  const rel = formatRelative(session.lastEventAt) ?? "—";
  const time = session.state === "waiting" ? `waiting ${rel}`
    : session.state === "disconnected" ? `disconnected ${rel}`
    : rel;
  const title = session.title ?? "(no title yet)";
  // Prefer the most specific label available: source (folder) > space >
  // cwd basename for orphan sessions. Always tooltip the full cwd so
  // the user can identify where the session was running.
  const cwdBasename = session.cwd ? session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? null : null;
  const projectLabel = session.sourceLabel ?? spaceLabel ?? cwdBasename ?? "—";
  return (
    <div
      className="home-row"
      onClick={() => onOpen?.(session.id)}
      onKeyDown={onOpen ? (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(session.id); }
      } : undefined}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
    >
      <span className={`home-row-status ${session.state}`} />
      <span className="home-row-space" title={session.cwd ?? undefined}>{projectLabel}</span>
      <span className="home-row-title" title={title}>{title}</span>
      <span className={`home-row-agent ${AGENT_PIP_CLASS[session.agent]}`}>
        <span className="home-agent-pip" />
        {session.agent}
      </span>
      <span className="home-row-time">{time}</span>
    </div>
  );
}
