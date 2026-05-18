// Client for /api/terminals/*. Source-typed launch contract; never sends a
// raw cwd.
import { getJson, del, ApiError } from "./http";

export type LaunchKind = "claude_new" | "claude_resume";
export type LaunchSource =
  | { type: "project"; id: string }
  | { type: "session"; id: string }
  | { type: "remote_session"; id: string };

export interface LaunchedTerminal {
  terminalId: string;
  kind: LaunchKind;
  cwd: string;
  displayName: string;
  command: string;
  args: string[];
  startedAt: number;
}

export interface ListedTerminal {
  terminalId: string;
  kind: LaunchKind;
  cwd: string;
  command: string;
  args: string[];
  startedAt: number;
  linkedSessionId: string | null;
  alive: boolean;
}

export type LaunchResult =
  | { ok: true; data: LaunchedTerminal }
  | { ok: false; error: string; installHint?: string };

export async function launchClaudeTerminal(input: {
  kind: LaunchKind;
  source: LaunchSource;
}): Promise<LaunchResult> {
  try {
    const res = await fetch("/api/terminals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: input.kind, source: input.source }),
    });
    if (!res.ok) {
      let body: unknown = null;
      try { body = await res.json(); } catch { /* non-JSON */ }
      const err = typeof body === "object" && body && "error" in body
        ? String((body as { error: unknown }).error)
        : `http_${res.status}`;
      const installHint = typeof body === "object" && body && "installHint" in body
        ? String((body as { installHint: unknown }).installHint)
        : undefined;
      return { ok: false, error: err, installHint };
    }
    const data = await res.json() as LaunchedTerminal;
    return { ok: true, data };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    return { ok: false, error: err instanceof Error ? err.message : "launch_failed" };
  }
}

export async function listTerminals(): Promise<ListedTerminal[]> {
  return getJson<ListedTerminal[]>("/api/terminals");
}

export async function killTerminal(terminalId: string): Promise<void> {
  await del(`/api/terminals/${encodeURIComponent(terminalId)}`);
}
