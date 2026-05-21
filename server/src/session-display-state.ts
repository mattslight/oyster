import type { SessionState, DisplayState } from "../../shared/types.js";
import { DORMANT_THRESHOLD_MS } from "./session-state.js";

// Re-export so callers that already import this module can keep their
// import paths. The canonical source is session-state.js, alongside the
// state and reason derivation rules.
export { DORMANT_THRESHOLD_MS };

/**
 * Maps the persisted state to the wire-format displayState. The only
 * difference is that 'disconnected' rows older than 8h are presented as
 * 'dormant' to dim the urgency. Other states pass through unchanged.
 */
export function computeDisplayState(
  state: SessionState,
  lastEventAt: string,
  now: number = Date.now(),
): DisplayState {
  if (state !== "disconnected") return state;
  const ts = Date.parse(lastEventAt);
  if (!Number.isFinite(ts)) return "disconnected";
  return now - ts > DORMANT_THRESHOLD_MS ? "dormant" : "disconnected";
}
