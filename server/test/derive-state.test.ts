import { describe, it, expect } from "vitest";
import { deriveState } from "../src/watchers/claude-code.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

const base = {
  terminalId: null as string | null,
  ageMs: 0,
  probeSignal: "unknown" as const,
  exitCode: null as number | null,
  exitSignal: null as string | null,
  explicitExitSeen: false,
  cleanProcessExit: false,
  userStopRequested: false,
  lastAssistantStopReason: null as string | null,
};

describe("deriveState — evidence-first", () => {
  it("managed + recent activity → active", () => {
    expect(deriveState({ ...base, terminalId: "t1", ageMs: 5_000 })).toBe("active");
  });

  it("managed + last stop_reason end_turn → waiting", () => {
    expect(deriveState({ ...base, terminalId: "t1", ageMs: 5_000, lastAssistantStopReason: "end_turn" })).toBe("waiting");
  });

  it("managed + last stop_reason tool_use → active (still thinking)", () => {
    expect(deriveState({ ...base, terminalId: "t1", ageMs: 90_000, lastAssistantStopReason: "tool_use" })).toBe("active");
  });

  it("managed + last stop_reason max_tokens → waiting (truncated, user must continue)", () => {
    expect(deriveState({ ...base, terminalId: "t1", ageMs: 5_000, lastAssistantStopReason: "max_tokens" })).toBe("waiting");
  });

  it("managed + last stop_reason stop_sequence → waiting", () => {
    expect(deriveState({ ...base, terminalId: "t1", ageMs: 5_000, lastAssistantStopReason: "stop_sequence" })).toBe("waiting");
  });

  it("managed + last stop_reason refusal → waiting", () => {
    expect(deriveState({ ...base, terminalId: "t1", ageMs: 5_000, lastAssistantStopReason: "refusal" })).toBe("waiting");
  });

  it("managed + last stop_reason pause_turn → active (interleaved thinking still in flight)", () => {
    expect(deriveState({ ...base, terminalId: "t1", ageMs: 5_000, lastAssistantStopReason: "pause_turn" })).toBe("active");
  });

  it("explicit /exit observed → done regardless of age", () => {
    expect(deriveState({ ...base, explicitExitSeen: true, ageMs: 10 * HOUR })).toBe("done");
  });

  it("clean PTY exit observed → done regardless of age", () => {
    expect(deriveState({ ...base, cleanProcessExit: true, ageMs: 10 * HOUR })).toBe("done");
  });

  // Precedence: bad exit evidence beats clean exit evidence. A session that
  // ran /exit but then got SIGKILLed mid-shutdown should read as disconnected.
  it("bad exit beats explicit /exit", () => {
    expect(deriveState({ ...base, explicitExitSeen: true, exitSignal: "SIGKILL" })).toBe("disconnected");
  });

  it("bad exit beats clean process exit", () => {
    expect(deriveState({ ...base, cleanProcessExit: true, exitCode: 1 })).toBe("disconnected");
  });

  it("PTY exit with non-zero code → disconnected", () => {
    expect(deriveState({ ...base, exitCode: 1, ageMs: 1 * MIN })).toBe("disconnected");
  });

  it("PTY exit with signal → disconnected", () => {
    expect(deriveState({ ...base, exitSignal: "SIGKILL", ageMs: 1 * MIN })).toBe("disconnected");
  });

  // User explicitly clicked the red-square stop button. The signal IS the
  // shutdown mechanism, not evidence of a crash. The precedence guards
  // against pre-exit races by ALSO requiring process-exit evidence.
  it("user stop + SIGHUP exit → done (intentional kill, signal is the mechanism)", () => {
    expect(deriveState({ ...base, userStopRequested: true, exitSignal: "SIGHUP", ageMs: 1 * MIN })).toBe("done");
  });

  it("user stop + non-zero exit code → done", () => {
    expect(deriveState({ ...base, userStopRequested: true, exitCode: 143, ageMs: 1 * MIN })).toBe("done");
  });

  // The /exit-then-crash semantic stays exactly as today: no user_stop
  // intent recorded, signal evidence wins.
  it("/exit then external SIGKILL without user-stop intent → disconnected (crash mid-shutdown)", () => {
    expect(deriveState({ ...base, explicitExitSeen: true, exitSignal: "SIGKILL", ageMs: 1 * MIN })).toBe("disconnected");
  });

  // Guards a pre-exit race: if the user-stop flag has been written but the
  // PTY hasn't actually exited yet, deriveState must NOT report 'done'
  // (the process is still alive on the other end of the terminal).
  it("user stop without process exit evidence → falls through (process still alive)", () => {
    // PTY still linked, recent activity → active
    expect(deriveState({ ...base, userStopRequested: true, terminalId: "t1", ageMs: 5_000 })).toBe("active");
    // No exit columns set yet but terminal already unlinked → existing fallthrough
    expect(deriveState({ ...base, userStopRequested: true, ageMs: 5_000 })).toBe("active");
  });

  it("exit_code = 0 alone (cleanProcessExit flag missing) falls through to time/probe", () => {
    // Defensive guard against future refactors in claude-pty-manager
    // that might decouple exit_code === 0 from clean_process_exit.
    expect(deriveState({ ...base, exitCode: 0, ageMs: 5 * MIN, probeSignal: "absent" })).toBe("disconnected");
    expect(deriveState({ ...base, exitCode: 0, ageMs: 30_000 })).toBe("active");
  });

  it("unmanaged, <60s → active", () => {
    expect(deriveState({ ...base, ageMs: 30_000 })).toBe("active");
  });

  it("unmanaged, 60s–30min, probe alive → waiting", () => {
    expect(deriveState({ ...base, ageMs: 5 * MIN, probeSignal: "alive" })).toBe("waiting");
  });

  it("unmanaged, 60s–30min, probe absent → disconnected", () => {
    expect(deriveState({ ...base, ageMs: 5 * MIN, probeSignal: "absent" })).toBe("disconnected");
  });

  it("unmanaged, 30min–8h → disconnected", () => {
    expect(deriveState({ ...base, ageMs: 4 * HOUR })).toBe("disconnected");
  });

  // 8h+ idle still returns 'disconnected' from deriveState; 'dormant' is
  // computed at the presentation layer (see Task 6) and never persisted.
  it("unmanaged, >8h, no exit evidence → disconnected (dormant happens at display time)", () => {
    expect(deriveState({ ...base, ageMs: 12 * HOUR })).toBe("disconnected");
  });
});
