// SessionActions — extracted from SessionInspector for navigability.
import { useState } from "react";
import type { Session } from "../../data/sessions-api";
import { ConfirmModal } from "../ConfirmModal";

// POSIX single-quote: wrap in 's, replace embedded ' with '\''. Keeps
// paths with spaces, $, backticks, etc. literal so resume can be pasted
// straight into bash/zsh.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function SessionActions({ session, onLaunchClaude }: {
  session: Session;
  /** Continue this session in an Oyster terminal (`claude --resume`).
   *  "Start new" lives on the project tile, not here — the inspector is
   *  about *this* transcript. */
  onLaunchClaude?: () => void;
}) {
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [forkWarningOpen, setForkWarningOpen] = useState(false);

  // A session that's active or waiting AND not currently running in Oyster
  // is alive somewhere else (the user's own claude CLI, another device,
  // another tab). Resuming it here would attach a second claude process
  // to the same session id and fork the conversation.
  const forkRisk = (session.state === "active" || session.state === "waiting")
    && session.terminalId == null;
  // `cd --` disables option parsing so a path beginning with `-` (or
  // the literal `-`, which would otherwise mean "previous dir") is
  // taken as a positional path argument. Single-quoting handles
  // spaces/$/backticks; `--` handles the leading-dash edge case.
  const command = session.cwd
    ? `cd -- ${shellQuote(session.cwd)} && claude --resume ${session.id}`
    : `claude --resume ${session.id}`;

  // "Resume here" is meaningful only on local sessions that still have a
  // cwd recorded. Remote (cross-device) sessions surface launch via the
  // ResumeDialog after reassembly.
  const canResumeInOyster = Boolean(onLaunchClaude && session.cwd && session.originDeviceId == null);

  function copyCommand() {
    if (!navigator.clipboard) {
      alert(`Copy failed — resume command:\n${command}`);
      return;
    }
    navigator.clipboard.writeText(command).then(
      () => {
        setCopiedCmd(true);
        setTimeout(() => setCopiedCmd(false), 1500);
      },
      () => alert(`Copy failed — resume command:\n${command}`),
    );
  }

  function copyId() {
    if (!navigator.clipboard) {
      alert(`Copy failed — session id:\n${session.id}`);
      return;
    }
    navigator.clipboard.writeText(session.id).then(
      () => {
        setCopiedId(true);
        setTimeout(() => setCopiedId(false), 1500);
      },
      () => alert(`Copy failed — session id:\n${session.id}`),
    );
  }

  return (
    <div className="inspector-actions">
      {canResumeInOyster && (
        <button
          type="button"
          className="btn primary"
          onClick={() => forkRisk ? setForkWarningOpen(true) : onLaunchClaude!()}
          title={`Run claude --resume ${session.id} in ${session.cwd}`}
        >
          Resume here
        </button>
      )}
      <button type="button" className="btn" onClick={copyCommand}>
        {copiedCmd ? "Copied!" : "Copy resume command"}
      </button>
      <button type="button" className="btn" onClick={copyId}>
        {copiedId ? "Copied!" : "Copy session ID"}
      </button>
      <ConfirmModal
        open={forkWarningOpen}
        title="This session is active outside Oyster"
        body={
          <p>
            Resuming here will start a second Claude process on the same session id and
            <strong> fork the conversation</strong>. The original copy will keep running where it is.
            <br /><br />
            To avoid forks, launch sessions from inside Oyster.
          </p>
        }
        confirmLabel="Resume anyway"
        cancelLabel="Cancel"
        destructive
        onCancel={() => setForkWarningOpen(false)}
        onConfirm={() => {
          setForkWarningOpen(false);
          onLaunchClaude!();
        }}
      />
    </div>
  );
}
