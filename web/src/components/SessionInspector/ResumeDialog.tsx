// Inline dialog rendered below SessionInspector's Header when the user
// clicks "Resume on this device" on a remote session. It steps through the
// server's five SessionResumeResponse shapes and surfaces the right next
// action.
//
// State machine:
//   loading       — POST in flight; show a small spinner-ish message
//   ok            — show copyable `cd <path> && claude --resume <id>` command
//   needs_target  — show a text input prefilled with remoteCwd (if known) +
//                   "Resume here" button → re-POST with { targetCwd }
//   pick_source   — multiple sources match this session's space; user
//                   chooses one → re-POST with that targetCwd
//   validation_   — show reasons + "Use this folder anyway" → re-POST with
//     warning       { targetCwd, force: true }
//   local_diverged— surface the conflict; resolution actions are 3.2 work
//   error         — generic failure (network, 5xx, 409 bytes_not_available)
//
// Folder picker is text-input-only in 3.1 — native picker is 3.2.

import { useEffect, useState } from "react";
import type { Session } from "../../data/sessions-api";
import { resumeSession, type SessionResumeResponse } from "../../data/sessions-api";

interface ResumeDialogProps {
  session: Session;
  onClose: () => void;
}

interface DialogState {
  // The response we're currently rendering. Null on first paint.
  response: SessionResumeResponse | null;
  /** Path the user typed into the override input. Persisted across
   *  re-POSTs so a validation_warning rejection doesn't lose their input. */
  draftCwd: string;
  /** Network/5xx error message. Cleared on the next attempt. */
  error: string | null;
  /** True between submit and response. */
  loading: boolean;
}

export function ResumeDialog({ session, onClose }: ResumeDialogProps) {
  const [state, setState] = useState<DialogState>({
    response: null,
    draftCwd: "",
    error: null,
    loading: true,
  });
  const [copied, setCopied] = useState(false);

  // Kick off the initial auto-resolve POST when the dialog mounts.
  // Session id is stable for the dialog's lifetime so this fires once.
  useEffect(() => {
    runResume({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  async function runResume(opts: { targetCwd?: string; force?: boolean }): Promise<void> {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const response = await resumeSession(session.id, opts);
      setState((s) => ({
        ...s,
        response,
        // Carry forward the override path so the input doesn't clear on
        // re-renders. needs_target also seeds it from remoteCwd below.
        draftCwd: opts.targetCwd ?? s.draftCwd,
        loading: false,
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  // Match the existing SessionActions copy pattern: feature-detect the
  // async clipboard API, fall back to alert() when blocked (insecure
  // origin, permissions), and never produce an unhandled rejection.
  function copyCommand(command: string): void {
    if (!navigator.clipboard) {
      alert(`Copy failed — resume command:\n${command}`);
      return;
    }
    navigator.clipboard.writeText(command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => alert(`Copy failed — resume command:\n${command}`),
    );
  }

  return (
    <div className="resume-dialog" role="region" aria-label="Resume session on this device">
      <div className="resume-dialog-header">
        <h3>Resume on this device</h3>
        <button type="button" className="close" onClick={onClose} aria-label="Close">✕</button>
      </div>

      {state.loading && <div className="resume-loading">Working…</div>}

      {state.error && (
        <div className="resume-error">
          <p>Something went wrong: {state.error}</p>
          <button type="button" onClick={() => runResume({})}>Retry</button>
        </div>
      )}

      {!state.loading && state.response?.status === "ok" && (
        <OkPanel response={state.response} copied={copied} onCopy={copyCommand} />
      )}

      {!state.loading && state.response?.status === "needs_target" && (
        <NeedsTargetPanel
          response={state.response}
          draftCwd={state.draftCwd}
          onDraftChange={(v) => setState((s) => ({ ...s, draftCwd: v }))}
          onSubmit={(cwd) => runResume({ targetCwd: cwd })}
        />
      )}

      {!state.loading && state.response?.status === "validation_warning" && (
        <ValidationPanel
          response={state.response}
          draftCwd={state.draftCwd}
          onSubmit={(cwd) => runResume({ targetCwd: cwd, force: true })}
        />
      )}

      {!state.loading && state.response?.status === "local_diverged" && (
        <DivergedPanel response={state.response} />
      )}

      {!state.loading && state.response?.status === "pick_source" && (
        <PickSourcePanel
          response={state.response}
          onChoose={(path) => runResume({ targetCwd: path })}
        />
      )}
    </div>
  );
}

// ── Panels ──

function OkPanel({
  response, copied, onCopy,
}: {
  response: Extract<SessionResumeResponse, { status: "ok" }>;
  copied: boolean;
  onCopy: (cmd: string) => void;
}) {
  return (
    <div className="resume-panel resume-ok">
      <p>Transcript ready at <code>{response.jsonlPath}</code>.</p>
      <p>Run this in a terminal to continue the session:</p>
      <div className="resume-command">
        <code>{response.command}</code>
        <button type="button" onClick={() => onCopy(response.command)}>
          {copied ? "Copied" : "Copy command"}
        </button>
      </div>
    </div>
  );
}

function NeedsTargetPanel({
  response, draftCwd, onDraftChange, onSubmit,
}: {
  response: Extract<SessionResumeResponse, { status: "needs_target" }>;
  draftCwd: string;
  onDraftChange: (v: string) => void;
  onSubmit: (cwd: string) => void;
}) {
  // Prefill the input with the origin cwd as a hint. The user almost
  // always wants something different (it's a foreign-device path), but
  // it's a useful starting point and they can edit. If they've already
  // typed something, preserve that.
  const value = draftCwd || response.remoteCwd || "";
  return (
    <div className="resume-panel resume-needs-target">
      <p>No local folder is registered for this session.</p>
      <p>Paste the path to the folder where you'd like to continue:</p>
      <input
        type="text"
        value={value}
        placeholder="/path/to/project"
        onChange={(e) => onDraftChange(e.target.value)}
        spellCheck={false}
        autoFocus
      />
      <button
        type="button"
        disabled={!value.trim()}
        onClick={() => onSubmit(value.trim())}
      >
        Resume here
      </button>
    </div>
  );
}

function ValidationPanel({
  response, draftCwd, onSubmit,
}: {
  response: Extract<SessionResumeResponse, { status: "validation_warning" }>;
  draftCwd: string;
  onSubmit: (cwd: string) => void;
}) {
  return (
    <div className="resume-panel resume-warning">
      <p>This folder doesn't quite match the original session:</p>
      <ul>
        {response.reasons.map((r) => (
          <li key={r}>{humanReason(r)}</li>
        ))}
      </ul>
      <p>You can resume here anyway — earlier turns will reference paths that don't exist on this machine, but Claude Code will continue from the conversation context.</p>
      <button type="button" onClick={() => onSubmit(draftCwd.trim())}>Use this folder anyway</button>
    </div>
  );
}

function DivergedPanel({
  response,
}: {
  response: Extract<SessionResumeResponse, { status: "local_diverged" }>;
}) {
  return (
    <div className="resume-panel resume-diverged">
      <p>This device has local-only edits past what's in the cloud.</p>
      <p className="resume-tech">
        Local transcript at <code>{response.localJsonlPath}</code> diverges from the cloud chain.
      </p>
      <p>Resolution (keep local as a fork, or discard local and pull cloud) is coming in the next release.</p>
    </div>
  );
}

function PickSourcePanel({
  response, onChoose,
}: {
  response: Extract<SessionResumeResponse, { status: "pick_source" }>;
  onChoose: (path: string) => void;
}) {
  return (
    <div className="resume-panel resume-pick">
      <p>Multiple folders are linked to this session's space. Pick one:</p>
      <ul>
        {response.candidates.map((c) => (
          <li key={c.path}>
            <button type="button" onClick={() => onChoose(c.path)}>
              {c.label ?? c.path}
            </button>
            <code>{c.path}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Map raw reason codes the route returns to human-readable text.
function humanReason(code: string): string {
  switch (code) {
    case "folder_missing": return "Folder doesn't exist";
    case "not_git_repo":   return "Folder isn't a git repository";
    case "remote_mismatch": return "Git remote doesn't match the original";
    case "repo_basename_differs": return "Folder name differs from the original";
    default: return code;
  }
}
