// Header — extracted from SessionInspector for navigability.
import { useState } from "react";
import type { Session, SessionState } from "../../data/sessions-api";
import { useMyDeviceId } from "../../hooks/useMyDeviceId";
import { SessionActions } from "./SessionActions";
import { ResumeDialog, type OpenInOysterResult } from "./ResumeDialog";
import { formatTs } from "./utils";
import { formatRelative } from "../Home/utils";

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

export function Header({ session, onClose, onLaunchClaude, onConnect, onOpenInOyster }: {
  session: Session;
  onClose: () => void;
  /** Resume this session in an Oyster terminal (`claude --resume <id>`). */
  onLaunchClaude?: () => void;
  /** Focus / restore an already-running PTY for this session. */
  onConnect?: () => void;
  /** Launch a remote (cross-device) session in an Oyster terminal once
   *  its bytes have been reassembled. Surfaced by the ResumeDialog OkPanel. */
  onOpenInOyster?: (sessionId: string) => Promise<OpenInOysterResult>;
}) {
  const myDevice = useMyDeviceId();
  const myDeviceId = myDevice?.deviceId ?? null;
  // Show the Resume affordance only on remote sessions. A null myDeviceId
  // (identity still loading) suppresses the button — once it lands the
  // header re-renders and the button appears. hasBytes gates whether the
  // button is enabled vs. disabled.
  const isRemote = session.originDeviceId !== null
    && session.originDeviceId !== undefined
    && session.originDeviceId !== myDeviceId
    && myDeviceId !== null;
  const canResume = isRemote && session.hasBytes === true;
  const [resumeOpen, setResumeOpen] = useState(false);
  const [idCopied, setIdCopied] = useState(false);

  function copySessionId() {
    if (!navigator.clipboard) {
      alert(`Copy failed — session id:\n${session.id}`);
      return;
    }
    navigator.clipboard.writeText(session.id).then(
      () => {
        setIdCopied(true);
        setTimeout(() => setIdCopied(false), 1500);
      },
      () => alert(`Copy failed — session id:\n${session.id}`),
    );
  }

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
        <button
          type="button"
          className="inspector-sub-id"
          onClick={copySessionId}
          title="Click to copy session id"
        >
          {idCopied ? "Copied!" : session.id}
        </button>
        {" · started "}
        <span title={formatTs(session.startedAt)}>
          {formatRelative(session.startedAt) ?? formatTs(session.startedAt)}
        </span>
        {session.lastEventAt && session.lastEventAt !== session.startedAt && (
          <>
            {" · last active "}
            <span title={formatTs(session.lastEventAt)}>
              {formatRelative(session.lastEventAt) ?? formatTs(session.lastEventAt)}
            </span>
          </>
        )}
        {session.model ? ` · ${session.model}` : ""}
      </div>
      <SessionActions session={session} onLaunchClaude={onLaunchClaude} onConnect={onConnect} />

      {isRemote && (
        <div className="inspector-resume">
          <button
            type="button"
            disabled={!canResume}
            onClick={() => setResumeOpen(true)}
            title={canResume ? undefined : "Transcript bytes haven't synced from the origin device yet."}
          >
            Resume on this device
          </button>
          {!canResume && (
            <span className="inspector-resume-hint">Waiting for transcript to sync from origin device…</span>
          )}
        </div>
      )}

      {resumeOpen && (
        <ResumeDialog
          session={session}
          onClose={() => setResumeOpen(false)}
          onOpenInOyster={onOpenInOyster}
        />
      )}
    </header>
  );
}
