// Table-driven tests for deriveReason. Each branch of the priority order
// in session-state.ts is exercised at least once. The headline case is the
// user_stop kill (SIGHUP + exitCode 129) — the user-visible bug this whole
// task fixes — which should read "stopped by user" *and* leave deriveState
// at "done" with no transient "disconnected".

import { describe, it, expect } from "vitest";
import { deriveReason, deriveState } from "../src/session-state.js";

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

describe("deriveReason", () => {
  // 1. Bad exit, no user-stop intent.
  it("killed by signal (no user stop intent)", () => {
    expect(deriveReason({ ...base, exitSignal: "SIGKILL" })).toBe("killed by SIGKILL");
  });

  it("crashed with non-zero exit code (no signal, no user stop intent)", () => {
    expect(deriveReason({ ...base, exitCode: 1 })).toBe("crashed (exit 1)");
  });

  // 2. User stop with exit evidence — the headline case.
  it("user_stop + SIGHUP + exitCode 129 → 'stopped by user'", () => {
    const input = {
      ...base,
      userStopRequested: true,
      exitSignal: "SIGHUP",
      exitCode: 129,
    };
    expect(deriveReason(input)).toBe("stopped by user");
    expect(deriveState(input)).toBe("done");
  });

  it("user_stop with clean exit → 'stopped by user'", () => {
    expect(deriveReason({ ...base, userStopRequested: true, cleanProcessExit: true })).toBe(
      "stopped by user",
    );
  });

  // 3. Explicit /exit observed.
  it("explicit /exit → 'ran /exit'", () => {
    expect(deriveReason({ ...base, explicitExitSeen: true })).toBe("ran /exit");
  });

  // 4. Clean process exit (no /exit, no user stop).
  it("clean process exit → 'exited cleanly'", () => {
    expect(deriveReason({ ...base, cleanProcessExit: true })).toBe("exited cleanly");
  });

  // 5. Managed (terminalId set) — assistant stop_reason drives the copy.
  it("managed + end_turn → 'awaiting input'", () => {
    expect(deriveReason({ ...base, terminalId: "t1", lastAssistantStopReason: "end_turn" })).toBe(
      "awaiting input",
    );
  });

  it("managed + tool_use → 'running a tool'", () => {
    expect(deriveReason({ ...base, terminalId: "t1", lastAssistantStopReason: "tool_use" })).toBe(
      "running a tool",
    );
  });

  it("managed + pause_turn → 'thinking'", () => {
    expect(deriveReason({ ...base, terminalId: "t1", lastAssistantStopReason: "pause_turn" })).toBe(
      "thinking",
    );
  });

  it("managed + max_tokens → 'max tokens — needs continuation'", () => {
    expect(deriveReason({ ...base, terminalId: "t1", lastAssistantStopReason: "max_tokens" })).toBe(
      "max tokens — needs continuation",
    );
  });

  it("managed + refusal → 'refused — needs input'", () => {
    expect(deriveReason({ ...base, terminalId: "t1", lastAssistantStopReason: "refusal" })).toBe(
      "refused — needs input",
    );
  });

  it("managed + stop_sequence → 'stopped at sequence — needs input'", () => {
    expect(deriveReason({ ...base, terminalId: "t1", lastAssistantStopReason: "stop_sequence" })).toBe(
      "stopped at sequence — needs input",
    );
  });

  // Cases that don't add info beyond colour + age return "" so the
  // Reason column renders dark (suppressed).

  it("managed + null stop_reason (pre-first-assistant) → '' (purple dot + age says enough)", () => {
    expect(deriveReason({ ...base, terminalId: "t1", lastAssistantStopReason: null })).toBe("");
  });

  it("managed + unknown stop_reason → '' (suppressed)", () => {
    expect(deriveReason({ ...base, terminalId: "t1", lastAssistantStopReason: "future_value" })).toBe("");
  });

  // 6. Unmanaged — only surface probe-derived copy that adds info beyond age.
  it("unmanaged + age < 60s → '' (green dot + age says enough)", () => {
    expect(deriveReason({ ...base, ageMs: 30_000 })).toBe("");
  });

  it("unmanaged + 60s–30min + probe alive → 'idle, process detected'", () => {
    expect(deriveReason({ ...base, ageMs: 5 * MIN, probeSignal: "alive" })).toBe(
      "idle, process detected",
    );
  });

  it("unmanaged + 60s–30min + probe absent → 'process not found'", () => {
    expect(deriveReason({ ...base, ageMs: 5 * MIN, probeSignal: "absent" })).toBe(
      "process not found",
    );
  });

  it("unmanaged + 60s–30min + probe unknown → '' (no probe info to add)", () => {
    expect(deriveReason({ ...base, ageMs: 5 * MIN, probeSignal: "unknown" })).toBe("");
  });

  it("unmanaged + 30min–8h → '' (red dot + LAST ACTIVE says enough)", () => {
    expect(deriveReason({ ...base, ageMs: 2 * HOUR })).toBe("");
  });

  it("unmanaged + 8h+ → '' (grey dormant dot + LAST ACTIVE says enough)", () => {
    expect(deriveReason({ ...base, ageMs: 12 * HOUR })).toBe("");
  });

  // Sanity: deriveState + deriveReason agree on the user_stop kill from the
  // headline UX fix. With process-exit evidence + user_stop intent, state is
  // 'done' and reason is 'stopped by user' — no transient red flicker possible.
  it("deriveState and deriveReason agree on the headline user_stop kill", () => {
    const input = {
      ...base,
      userStopRequested: true,
      exitSignal: "SIGHUP",
      exitCode: 129,
    };
    expect(deriveState(input)).toBe("done");
    expect(deriveReason(input)).toBe("stopped by user");
  });
});
