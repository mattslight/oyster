// Tiny LRU for "recently used" project ids in the New Session palette.
// Persisted to localStorage so recents survive reloads. Capped at 5; the
// list is the source of truth, no separate count maintained. localStorage
// can throw in privacy-mode browsers — every read/write is try/catch.

const KEY = "oyster-new-session-recents";
const MAX = 5;

export function getRecentProjectIds(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string").slice(0, MAX);
  } catch {
    return [];
  }
}

export function recordRecentProjectId(projectId: string): void {
  if (!projectId) return;
  try {
    const current = getRecentProjectIds().filter((id) => id !== projectId);
    const next = [projectId, ...current].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* privacy-mode browsers — recents simply don't persist */
  }
}
