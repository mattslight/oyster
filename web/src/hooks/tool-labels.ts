// Friendly progress labels for tool names
export const TOOL_LABELS: Record<string, string> = {
  read: "reading",
  edit: "editing",
  write: "writing",
  bash: "running command",
  glob: "searching files",
  grep: "searching code",
  webfetch: "fetching",
  websearch: "searching the web",
  task: "delegating",
  apply_patch: "editing",
  list: "listing",
};

// Extract a short context hint from a tool event's state.input
export function extractToolHint(part: Record<string, unknown>): string | null {
  const state = part.state as Record<string, unknown> | undefined;
  if (!state) return null;
  const input = state.input as Record<string, unknown> | undefined;
  if (!input) return null;
  // File-based tools: extract basename from file_path or path
  const filePath = (input.file_path || input.path) as string | undefined;
  if (filePath && typeof filePath === "string") {
    const name = filePath.split("/").pop() || null;
    if (name && name.length > 30) return name.slice(0, 27) + "...";
    return name;
  }
  // Glob: show pattern
  const pattern = input.pattern as string | undefined;
  if (pattern) return pattern.length > 30 ? pattern.slice(0, 27) + "..." : pattern;
  // Task/Agent: show description
  const desc = input.description as string | undefined;
  if (desc) return desc.length > 30 ? desc.slice(0, 27) + "..." : desc;
  return null;
}
