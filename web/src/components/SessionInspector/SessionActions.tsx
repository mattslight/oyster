// SessionActions — extracted from SessionInspector for navigability.
import { useState } from "react";
import type { Session } from "../../data/sessions-api";

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
          onClick={() => onLaunchClaude!()}
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
    </div>
  );
}
