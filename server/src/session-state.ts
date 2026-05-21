// Single source of truth for deriving a session's `state` and a
// short human-readable `displayReason` from the evidence columns
// (exit_code/exit_signal/clean_process_exit/explicit_exit_seen/
// user_stop_requested_at/last_assistant_stop_reason) plus the live
// process probe.
//
// Why a dedicated module: `_handleExit` (PTY exit handler) and
// `runHeartbeatSweep` (periodic refresh) used to embed their own
// state logic. `_handleExit` had a naive `cleanProcessExit ? 'done'
// : 'disconnected'` branch that didn't know about `userStopRequested`,
// so a UI red-square stop would briefly write 'disconnected' (red dot)
// until the next heartbeat tick re-derived to 'done' (grey dot). The
// fix is to keep deriveState in one place and call it from both.

import type { SessionState } from "../../shared/types.js";

// `signal` is tri-state to handle Windows / probe-unavailable gracefully:
//   "alive"   — probe ran, found a claude process at this cwd
//   "absent"  — probe ran, found no claude at this cwd (terminal closed)
//   "unknown" — probe couldn't run at all (no pgrep). Treat as benefit-
//               of-doubt: a recent session reads as waiting, not
//               disconnected. Otherwise Windows would force every idle
//               session to disconnected, worse than the pre-probe state.
export type ProbeSignal = "alive" | "absent" | "unknown";

export const ACTIVE_WINDOW_MS = 60_000;
export const WAITING_WINDOW_MS = 30 * 60 * 1000;
// 8h+ idle "disconnected" rows are presented as `dormant` on the wire.
// Consumed by `computeDisplayState` in `session-display-state.ts` —
// kept here alongside the other time windows so all the thresholds the
// state machine cares about live in one place.
export const DORMANT_THRESHOLD_MS = 8 * 60 * 60 * 1000;

export interface DeriveStateInput {
  terminalId: string | null;
  ageMs: number;
  probeSignal: ProbeSignal;
  exitCode: number | null;
  exitSignal: string | null;
  explicitExitSeen: boolean;
  cleanProcessExit: boolean;
  /** The user clicked the red-square stop button. Recorded *before* the
   *  signal is sent so the eventual signal-driven PTY exit isn't
   *  classified as a crash. Paired with process-exit evidence in
   *  deriveState so a row can't briefly read 'done' while the PTY is
   *  still alive (i.e., the intent flag has been written but the
   *  process hasn't yet exited). */
  userStopRequested: boolean;
  lastAssistantStopReason: string | null;
}

export function deriveState(input: DeriveStateInput): SessionState {
  // User-initiated stop, once the process has actually exited: the signal
  // (typically SIGHUP from node-pty's default kill()) IS the shutdown
  // mechanism, not evidence of a crash. Requires process-exit evidence so
  // a pre-exit race (flag written, PTY not yet down) doesn't yield 'done'
  // while the underlying process is still running.
  const hasProcessExitEvidence =
    input.exitCode != null || input.exitSignal != null || input.cleanProcessExit;
  if (input.userStopRequested && hasProcessExitEvidence) return "done";

  // Precedence: bad exit evidence beats any "clean" claim that lacks user
  // intent. A session that typed /exit and then got SIGKILLed
  // mid-shutdown should read disconnected, not done.
  if (input.exitSignal || (input.exitCode != null && input.exitCode !== 0)) {
    return "disconnected";
  }
  if (input.explicitExitSeen || input.cleanProcessExit) return "done";
  if (input.terminalId) {
    // Only "computing" stop reasons keep us in active. `null` means we
    // haven't seen any assistant event yet (user just opened the session
    // or sent their first prompt — the agent IS computing). `tool_use`
    // and `pause_turn` are genuine in-flight signals. Every other stop
    // reason (end_turn, max_tokens, stop_sequence, refusal) means the
    // model has stopped and the user is the next actor.
    const computing =
      input.lastAssistantStopReason === null ||
      input.lastAssistantStopReason === "tool_use" ||
      input.lastAssistantStopReason === "pause_turn";
    return computing ? "active" : "waiting";
  }
  if (input.ageMs < ACTIVE_WINDOW_MS) return "active";
  if (input.ageMs < WAITING_WINDOW_MS) {
    return input.probeSignal === "absent" ? "disconnected" : "waiting";
  }
  // 8h+ idle is still 'disconnected' in the persisted enum. The presentation
  // layer (sessions API) maps disconnected + age > 8h into 'dormant' for the
  // wire-format displayState field. See Task 6.
  return "disconnected";
}

/** Short, lowercase, human-readable explanation for the row's current
 *  state. Pure derivation from the same evidence — no DB reads, no
 *  state argument needed (the priority order below makes the answer
 *  consistent with deriveState). */
export function deriveReason(input: DeriveStateInput): string {
  const userStop = input.userStopRequested;
  const hasExitEvidence =
    input.exitCode != null || input.exitSignal != null || input.cleanProcessExit;

  // 1. Bad exit with no user-stop intent → crash / external kill.
  if (!userStop) {
    if (input.exitSignal) return `killed by ${input.exitSignal}`;
    if (input.exitCode != null && input.exitCode !== 0) {
      return `crashed (exit ${input.exitCode})`;
    }
  }

  // 2. User stop, once the process has actually exited.
  if (userStop && hasExitEvidence) return "stopped by user";

  // 3. Explicit /exit observed in the transcript.
  if (input.explicitExitSeen) return "ran /exit";

  // 4. Clean process exit (code 0, no signal).
  if (input.cleanProcessExit) return "exited cleanly";

  // 5. Managed (PTY still linked) — describe the assistant's last stop_reason.
  // Bare "working" / "active" adds nothing beyond the purple dot + last-active
  // age, so suppress them (empty string → column renders dark). Only return
  // copy that actually explains something the colour and age don't.
  if (input.terminalId) {
    switch (input.lastAssistantStopReason) {
      case "end_turn": return "awaiting input";
      case "tool_use": return "running a tool";
      case "pause_turn": return "thinking";
      case "max_tokens": return "max tokens — needs continuation";
      case "refusal": return "refused — needs input";
      case "stop_sequence": return "stopped at sequence — needs input";
      default: return "";
    }
  }

  // 6. Unmanaged — only surface a reason when it adds info beyond colour + age.
  // `active` and bare `quiet Xh` echo the dot colour and the LAST ACTIVE
  // column; suppress them. Keep probe-derived copy because the probe tells
  // the user something the age doesn't (is the process actually there?).
  if (input.ageMs < WAITING_WINDOW_MS && input.ageMs >= ACTIVE_WINDOW_MS) {
    if (input.probeSignal === "alive") return "idle, process detected";
    if (input.probeSignal === "absent") return "process not found";
  }
  return "";
}
