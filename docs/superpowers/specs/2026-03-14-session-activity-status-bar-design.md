# Session Activity Status Bar — Design Spec

## Problem

When the AI is working on a task, the chatbar status shows unhelpful labels like "task..." because unmapped tool names fall through to a generic `${tool.toLowerCase()}...` fallback. Users can't tell if the AI is stuck or making progress.

## Scope

Fix the status bar text only. Collapsible tool blocks, generating-state icons on desktop, and structured activity logs are deferred.

## Solution

Single file change: `web/src/components/ChatBar.tsx`.

### 1. Expand `toolProgress` map and drop baked-in ellipsis

The existing map bakes `"..."` into each value (e.g. `"reading..."`). Change to bare labels — the ellipsis is appended during status text construction instead. This avoids double-ellipsis when filenames are appended.

```typescript
const toolProgress: Record<string, string> = {
  Read: "reading",
  Edit: "editing",
  Write: "writing",
  Bash: "running command",
  Glob: "searching files",
  Grep: "searching code",
  WebFetch: "fetching",
  WebSearch: "searching the web",
  Agent: "delegating",
  Task: "working",
};
```

Note: Only map tool names confirmed to exist in OpenCode's event stream. The existing `console.log("[oyster-event]", ...)` on line 168 logs all non-delta events — use browser console during a real session to discover any additional tool names and add them later.

### 2. Extract filenames from event data

The `message.part.updated` event carries a `part` object. The exact field names for tool arguments need to be confirmed from real event payloads (check browser console `[oyster-event]` logs). The implementation should defensively try multiple possible field paths:

```typescript
function extractFilename(part: Record<string, unknown>): string | null {
  // Try common field names — adjust based on actual OpenCode event shape
  const input = (part.input || part.args || part.arguments) as Record<string, unknown> | undefined;
  if (!input) return null;
  const filePath = (input.file_path || input.path) as string | undefined;
  if (!filePath || typeof filePath !== "string") return null;
  const name = filePath.split("/").pop() || null;
  // Truncate long filenames to keep status bar readable
  if (name && name.length > 30) return name.slice(0, 27) + "...";
  return name;
}
```

**Bash tool handling:** Do not extract filenames from Bash `command` fields — a command like `npm install` is not a file path. Bash always shows `"running command..."` with no suffix.

### 3. Better fallback

Unknown tools show `"working..."` instead of `"${tool.toLowerCase()}..."`.

### 4. Status text construction

```typescript
const label = toolProgress[tool] || "working";
const filename = extractFilename(part);
const status = filename ? `${label} ${filename}...` : `${label}...`;
setStatusText(status);
```

## Known Limitations

- **Rapid tool switching** causes status to flicker between labels. Not a regression — existing behaviour. A future iteration could debounce or show a stacked activity list.
- **Event payload shape is assumed** — the `extractFilename` field paths (`input`, `args`, `file_path`, `path`) are best guesses. Implementation should log and adapt based on real payloads.

## Files Changed

| File | Change |
|------|--------|
| `web/src/components/ChatBar.tsx` | Expand `toolProgress`, drop baked-in ellipsis, add `extractFilename()`, update fallback |

## Acceptance Criteria

- [ ] Known tools (Read, Edit, Write, Bash, Glob, Grep, Agent, Task) show descriptive labels
- [ ] File paths are extracted and displayed as basenames when available (truncated at 30 chars)
- [ ] Unknown tools show "working..." not cryptic tool names
- [ ] No UI/CSS changes — same pulsing status bar
