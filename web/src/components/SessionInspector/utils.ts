// Helpers shared across SessionInspector/* sub-components. Extracted from
// SessionInspector/index.tsx — pure functions only, no React state.
import type { SessionEvent } from "../../data/sessions-api";
import type { RoleCategory } from "./types";

// Matches the server default. If a fetch returns exactly this many events,
// assume there are more upstream and surface the "1000+" affordance.
export const PAGE_SIZE = 1000;

export const ALL_CATEGORIES: RoleCategory[] = ["user", "assistant", "tools", "system", "thinking"];
export const DEFAULT_VISIBLE: RoleCategory[] = ["user", "assistant", "tools", "system"];

// Match patterns the watcher's older code emitted for assistant-only-tool
// turns ("[Bash]", "[Edit] [Read]", etc.) so historical rows categorise
// as tools rather than thinking/assistant text.
export const TOOL_ONLY_RE = /^(\[[A-Za-z][A-Za-z0-9_-]*\]\s*)+$/;

export function categoryOf(event: SessionEvent): RoleCategory {
  if (event.role === "user") return "user";
  if (event.role === "tool" || event.role === "tool_result") return "tools";
  if (event.role === "system") return "system";
  if (event.role === "assistant") {
    if (event.text === "(thinking)") return "thinking";
    if (TOOL_ONLY_RE.test(event.text.trim())) return "tools";
    return "assistant";
  }
  return "system";
}

export function loadVisibleCategories(): Set<RoleCategory> {
  try {
    const stored = window.localStorage.getItem("oyster.inspector.transcriptFilter");
    if (stored) {
      const parsed = JSON.parse(stored) as RoleCategory[];
      const valid = parsed.filter((c) => ALL_CATEGORIES.includes(c));
      if (valid.length > 0) return new Set(valid);
    }
  } catch { /* fall through */ }
  return new Set(DEFAULT_VISIBLE);
}

export function saveVisibleCategories(set: Set<RoleCategory>) {
  try {
    window.localStorage.setItem(
      "oyster.inspector.transcriptFilter",
      JSON.stringify(Array.from(set)),
    );
  } catch { /* ignore */ }
}

export function formatTs(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function formatRel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
