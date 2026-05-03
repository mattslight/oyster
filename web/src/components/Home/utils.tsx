// Helpers shared across Home/* sub-components. Extracted from
// Home/index.tsx — pure functions only, no React state.
import type { Session, SessionState, SessionAgent } from "../../data/sessions-api";
import type { Space } from "../../../../shared/types";
import { parseTimestamp } from "../../utils/parseTimestamp";

export const AGENT_LETTERS: Record<SessionAgent, string> = {
  "claude-code": "CC",
  opencode: "OC",
  codex: "CX",
};

export const AGENT_CLASS: Record<SessionAgent, string> = {
  "claude-code": "agent-cc",
  opencode: "agent-oc",
  codex: "agent-codex",
};

export const AGENT_PIP_CLASS: Record<SessionAgent, string> = {
  "claude-code": "cc",
  opencode: "oc",
  codex: "codex",
};

// Collapse `/Users/<name>/...` and `/home/<name>/...` to `~/...` so
// orphan-cwd labels read at a glance. Falls through unchanged for
// Windows paths and anything outside the user home tree.
export function homeRelative(p: string): string {
  const m = p.match(/^\/(?:Users|home)\/[^/]+/);
  return m ? "~" + p.slice(m[0].length) : p;
}

// Compact pip + numeral, one per non-zero state. Same glow primitive
// the Active-projects tile signals use, just without the trailing
// state word — fits in a breadcrumb pill while keeping counts exact
// and the visual language consistent with the tiles.
export function renderPipCounts(counts: { active?: number; waiting?: number; disconnected?: number }) {
  const a = counts.active ?? 0;
  const w = counts.waiting ?? 0;
  const d = counts.disconnected ?? 0;
  if (a + w + d === 0) return null;
  return (
    <>
      {a > 0 && <span className="pip-count"><span className="pip pip-green" />{a}</span>}
      {w > 0 && <span className="pip-count"><span className="pip pip-amber" />{w}</span>}
      {d > 0 && <span className="pip-count"><span className="pip pip-red" />{d}</span>}
    </>
  );
}

export function stateColor(state: SessionState): "green" | "amber" | "red" | "dim" {
  switch (state) {
    case "active": return "green";
    case "waiting": return "amber";
    case "disconnected": return "red";
    case "done": return "dim";
  }
}

export function spaceLabelFor(spaceId: string | null, spaces: Space[]): string | null {
  if (!spaceId) return null;
  return spaces.find((s) => s.id === spaceId)?.displayName ?? spaceId;
}

export function metaForSession(session: Session): string {
  const rel = formatRelative(session.lastEventAt) ?? "—";
  if (session.state === "waiting") return `${session.agent} · waiting ${rel}`;
  if (session.state === "disconnected") return `${session.agent} · disconnected ${rel}`;
  return `${session.agent} · ${rel}`;
}

export function formatRelative(iso: string): string | null {
  const t = parseTimestamp(iso);
  if (!Number.isFinite(t)) return null;
  const ms = Date.now() - t;
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(t).toLocaleDateString();
}

export function pluralize(n: number, unit: string): string {
  if (n === 1) return unit;
  if (unit.endsWith("y")) return unit.slice(0, -1) + "ies";
  return unit + "s";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
