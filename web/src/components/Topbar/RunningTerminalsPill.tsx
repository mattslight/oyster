import { useState, useRef, useEffect } from "react";
import type { TerminalPresence, PresenceInfo } from "../../hooks/useTerminalPresence";
import type { Session } from "../../data/sessions-api";
import { ConfirmModal } from "../ConfirmModal";

interface Props {
  presence: TerminalPresence;
  sessions: Session[];
  onFocus: (terminalId: string) => void;
  onRestore: (sessionId: string, terminalId: string) => void;
  onStop: (terminalId: string) => Promise<void>;
}

export function RunningTerminalsPill({ presence, sessions, onFocus, onRestore, onStop }: Props) {
  const [open, setOpen] = useState(false);
  const [pendingStopId, setPendingStopId] = useState<string | null>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);
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
        <span className="pip-count"><span className="pip pip-teal rtp-pulse-anim" />{presence.totalLive}</span>
        running
      </button>
      {open && (
        <div className="rtp-popover" ref={popoverRef}>
          <div className="rtp-popover-arrow" />
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
                <span className="rtp-dot" />
                <div className="rtp-body">
                  <span className="rtp-title">{title}</span>
                  <span className="rtp-meta">
                    <span className="rtp-space">{space}</span> · claude-code · {isAttached ? "open" : "minimised"}
                  </span>
                </div>
                <button
                  className="rtp-stop"
                  title="Stop terminal"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (localStorage.getItem("oyster-skip-stop-confirm") === "1") {
                      void onStop(info.terminalId);
                    } else {
                      setDontAskAgain(false);
                      setPendingStopId(info.terminalId);
                    }
                  }}
                >■</button>
              </div>
            );
          })}
        </div>
      )}
      <ConfirmModal
        open={pendingStopId !== null}
        title="Stop this terminal?"
        body={
          <>
            <p>Ending the session kills the Claude process and discards any in-progress work. The conversation history stays in the Sessions list.</p>
            <label className="rtp-confirm-checkbox">
              <input type="checkbox" checked={dontAskAgain} onChange={e => setDontAskAgain(e.target.checked)} />
              Don't ask me again
            </label>
          </>
        }
        confirmLabel="Stop terminal"
        cancelLabel="Cancel"
        destructive
        onCancel={() => setPendingStopId(null)}
        onConfirm={() => {
          if (dontAskAgain) localStorage.setItem("oyster-skip-stop-confirm", "1");
          const id = pendingStopId!;
          setPendingStopId(null);
          void onStop(id);
        }}
      />
    </div>
  );
}
