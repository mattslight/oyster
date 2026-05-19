import { useState, useRef, useEffect } from "react";
import type { TerminalPresence, PresenceInfo } from "../../hooks/useTerminalPresence";
import type { Session } from "../../data/sessions-api";

interface Props {
  presence: TerminalPresence;
  sessions: Session[];
  onFocus: (terminalId: string) => void;
  onRestore: (sessionId: string, terminalId: string) => void;
  onStop: (terminalId: string) => Promise<void>;
}

export function RunningTerminalsPill({ presence, sessions, onFocus, onRestore, onStop }: Props) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close popover when count drops to 0 — the pill disappears too.
  useEffect(() => {
    if (presence.totalLive === 0) setOpen(false);
  }, [presence.totalLive]);

  // Click-outside closes the popover.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (presence.totalLive === 0) return null;

  const rows: { info: PresenceInfo; session: Session | undefined }[] =
    [...presence.attached, ...presence.running].map(info => ({
      info,
      session: sessions.find(s => s.id === info.sessionId),
    }));

  return (
    <div className="rtp-wrap">
      <button
        className={`rtp-pill${open ? " rtp-pill--open" : ""}`}
        onClick={() => setOpen(o => !o)}
        title={`${presence.totalLive} running terminal${presence.totalLive === 1 ? "" : "s"}`}
      >
        <span className="rtp-pulse" />
        Running {presence.totalLive} ▾
      </button>
      {open && (
        <div className="rtp-popover" ref={popoverRef}>
          <div className="rtp-popover-arrow" />
          <div className="rtp-popover-head">
            <span>Running terminals</span>
            <span>{presence.totalLive}</span>
          </div>
          {rows.map(({ info, session }) => {
            const title = session?.title ?? info.sessionId.slice(0, 8);
            const space = session?.spaceId ?? "—";
            const isAttached = info.state === "attached";
            return (
              <div
                key={info.terminalId}
                className="rtp-row"
                onClick={() => isAttached ? onFocus(info.terminalId) : onRestore(info.sessionId, info.terminalId)}
              >
                <span className={isAttached ? "rtp-dot rtp-dot--attached" : "rtp-dot rtp-dot--running"} />
                <div className="rtp-body">
                  <span className="rtp-title">{title}</span>
                  <span className="rtp-meta">
                    <span className="rtp-space">{space}</span> · claude-code · {isAttached ? "open" : "minimised"}
                  </span>
                </div>
                {!isAttached && <span className="rtp-chip rtp-chip--restore">Restore</span>}
                <button
                  className="rtp-stop"
                  title="Stop terminal"
                  onClick={(e) => { e.stopPropagation(); void onStop(info.terminalId); }}
                >■</button>
              </div>
            );
          })}
          <div className="rtp-popover-foot">Click row to focus · Stop ends the session</div>
        </div>
      )}
    </div>
  );
}
