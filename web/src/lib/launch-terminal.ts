// Shared launch helper used by ProjectTile, SessionActions, and ResumeDialog.
// Owns: POST to /api/terminals, dispatch OPEN_CLAUDE_TERMINAL, surface
// failures via a single consistent UX (BinaryMissingModal + alert).
//
// The error vocabulary mirrors `routes/terminals.ts`. New codes added there
// should be reflected in `humanError` to keep the UI honest.

import type { Dispatch } from "react";
import {
  launchClaudeTerminal,
  type LaunchKind,
  type LaunchSource,
} from "../data/terminals-api";
import type { WindowAction } from "../stores/windows";

function basename(p: string): string {
  // Works for both POSIX and Windows separators. Trailing slash is stripped.
  const trimmed = p.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export interface LaunchOptions {
  kind: LaunchKind;
  source: LaunchSource;
  /** Window title (e.g. session title for resume). If omitted, derived
   *  from the resolved cwd's basename. */
  titleHint?: string;
}

export type LaunchOutcome =
  | { ok: true; terminalId: string }
  | { ok: false; error: string; installHint?: string };

export async function launchAndOpen(
  options: LaunchOptions,
  dispatch: Dispatch<WindowAction>,
): Promise<LaunchOutcome> {
  const result = await launchClaudeTerminal({ kind: options.kind, source: options.source });
  if (!result.ok) {
    return { ok: false, error: result.error, installHint: result.installHint };
  }
  const { terminalId, cwd, displayName, kind } = result.data;
  const cwdBase = basename(cwd);
  const titlePrefix = kind === "claude_resume" ? "resume" : "claude";
  const title = `${titlePrefix} · ${options.titleHint ?? displayName ?? cwdBase}`;
  dispatch({
    type: "OPEN_CLAUDE_TERMINAL",
    terminalId,
    title,
    cwd,
    kind,
  });
  return { ok: true, terminalId };
}

/** Human-readable copy for the error codes the route can return. Keep in
 *  sync with `routes/terminals.ts`. */
export function humanError(code: string): string {
  switch (code) {
    case "binary_not_found":
      return "Claude Code isn't installed on this machine.";
    case "project_not_found":
      return "This project no longer exists.";
    case "project_homeless":
      return "This project has no folder on this machine. Attach it first.";
    case "session_not_found":
      return "This session is no longer in your local index.";
    case "session_no_cwd":
      return "This session has no recorded working folder.";
    case "session_cwd_missing":
      return "The session's working folder no longer exists on disk.";
    case "session_not_reassembled_yet":
      return "The session's transcript hasn't finished downloading. Try again in a moment.";
    case "cwd_not_on_this_device":
      return "The session's working folder doesn't exist on this device. Resume on the device that has it.";
    case "cwd_not_a_directory":
      return "The resolved path isn't a folder.";
    case "too_many_terminals":
      return "You have too many Claude terminals open. Close one and try again.";
    case "pty_unavailable":
      return "Native terminal support isn't installed in this build.";
    case "invalid_kind":
    case "invalid_source":
    case "invalid_source_type":
    case "resume_requires_session_source":
    case "new_session_requires_project_or_session_source":
    case "cwd_not_accepted":
      return "Internal: invalid launch request.";
    default:
      return code;
  }
}
