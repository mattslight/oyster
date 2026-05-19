import { useMemo } from "react";
import type { Session } from "../data/sessions-api";
import type { WindowState } from "../stores/windows";

export type PresenceState = "attached" | "running";

export interface PresenceInfo {
  sessionId: string;
  terminalId: string;
  state: PresenceState;
  attachedClients: number;
}

export interface TerminalPresence {
  /** Sessions whose linked PTY currently has at least one attached window. */
  attached: PresenceInfo[];
  /** Sessions whose linked PTY is alive but no window is attached. */
  running: PresenceInfo[];
  byId: Record<string, PresenceInfo>;
  /** Convenience: attached.length + running.length. */
  totalLive: number;
}

/** Fuses two sources of truth:
 *
 *  - `sessions` carries `terminalId` + `terminalAttachedClients` from the
 *    server (DB-projected, SSE-refreshed by the parent's subscriber).
 *  - `windows` is the client-side list of open panels. A terminal id is
 *    "attached" iff a window in the store references that terminalId.
 *
 *  The DB column tells us if a PTY *exists*; the windows store tells us
 *  whether *this client* is currently looking at it. They are NOT
 *  redundant — the server counts every WS connection (including other
 *  tabs); the local store reflects only this tab's panels. */
export function useTerminalPresence(
  sessions: Session[],
  windows: WindowState[],
): TerminalPresence {
  return useMemo(() => {
    const localTerminalIds = new Set(
      windows.filter(w => w.type === "claude_terminal" && w.terminalId).map(w => w.terminalId!),
    );
    const attached: PresenceInfo[] = [];
    const running: PresenceInfo[] = [];
    const byId: Record<string, PresenceInfo> = {};
    for (const s of sessions) {
      if (!s.terminalId) continue;
      const isAttached = localTerminalIds.has(s.terminalId);
      const info: PresenceInfo = {
        sessionId: s.id,
        terminalId: s.terminalId,
        state: isAttached ? "attached" : "running",
        attachedClients: s.terminalAttachedClients,
      };
      byId[s.id] = info;
      (isAttached ? attached : running).push(info);
    }
    return { attached, running, byId, totalLive: attached.length + running.length };
  }, [sessions, windows]);
}
