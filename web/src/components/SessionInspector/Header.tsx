// Header — extracted from SessionInspector for navigability.
import type { Session, SessionState } from "../../data/sessions-api";
import { SessionActions } from "./SessionActions";
import { formatTs } from "./utils";

const PIP_CLASS: Record<SessionState, string> = {
  active: "green",
  waiting: "amber",
  disconnected: "red",
  done: "dim",
};

const STATE_LABEL: Record<SessionState, string> = {
  active: "active",
  waiting: "waiting on you",
  disconnected: "disconnected",
  done: "done",
};

export function Header({ session, onClose }: { session: Session; onClose: () => void }) {
  return (
    <header className="inspector-header">
      <div className="inspector-meta">
        {session.spaceId && <span className="space">{session.spaceId}</span>}
        {session.spaceId && <span>·</span>}
        <span className="agent">{session.agent}</span>
        <span>·</span>
        <span className={`pip ${PIP_CLASS[session.state]}`} />
        <span>{STATE_LABEL[session.state]}</span>
        <button type="button" className="close" onClick={onClose} aria-label="Close inspector">✕</button>
      </div>
      <div className="inspector-title">{session.title ?? "(no title yet)"}</div>
      <div className="inspector-sub">
        {session.id} · started {formatTs(session.startedAt)}
        {session.model ? ` · ${session.model}` : ""}
      </div>
      <SessionActions session={session} />
    </header>
  );
}
