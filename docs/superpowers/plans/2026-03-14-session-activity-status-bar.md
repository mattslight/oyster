# Session Activity Status Bar Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chatbar status text descriptive and useful during AI work sessions.

**Architecture:** Expand the `toolProgress` map in `ChatBar.tsx`, add a filename extractor for tool events, and fix the fallback for unknown tools. Single file change.

**Tech Stack:** React, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-14-session-activity-status-bar-design.md`

---

## Chunk 1: Status bar improvements

### Task 1: Expand toolProgress map and remove baked-in ellipsis

**Files:**
- Modify: `web/src/components/ChatBar.tsx:81-91`

- [ ] **Step 1: Update the toolProgress map**

Replace lines 81-91 in `ChatBar.tsx`:

```typescript
  // Friendly progress labels for tool names (ellipsis appended during construction)
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

### Task 2: Add filename extractor and update status text construction

**Files:**
- Modify: `web/src/components/ChatBar.tsx:245-267`

- [ ] **Step 1: Add extractFilename helper**

Add this function above the component definition (outside `ChatBar`, around line 57):

```typescript
// Extract a short filename from a tool event's part data
function extractFilename(part: Record<string, unknown>): string | null {
  const input = (part.input || part.args || part.arguments) as Record<string, unknown> | undefined;
  if (!input) return null;
  const filePath = (input.file_path || input.path) as string | undefined;
  if (!filePath || typeof filePath !== "string") return null;
  const name = filePath.split("/").pop() || null;
  if (name && name.length > 30) return name.slice(0, 27) + "...";
  return name;
}
```

- [ ] **Step 2: Update the message.part.updated handler**

Replace lines 261-266 (the tool progress section inside the `message.part.updated` case, including closing brace):

```typescript
          // Show tool progress — extract tool name from whichever field OpenCode uses
          const tool = part.toolName || part.name || part.tool;
          if (tool && part.type !== "text") {
            const label = toolProgress[tool] || "working";
            // Skip filename extraction for Bash (commands aren't file paths)
            const filename = tool === "Bash" ? null : extractFilename(part as Record<string, unknown>);
            setStatusText(filename ? `${label} ${filename}...` : `${label}...`);
          }
```

### Task 3: Verify and commit

- [ ] **Step 1: Manual verification**

1. Start the dev server: `cd web && npm run dev`
2. Open Oyster in browser
3. Send a message to the AI via the chatbar
4. Watch the status text — confirm it shows labels like "reading...", "writing...", "searching files..." instead of "task..."
5. Check browser console for `[oyster-event]` logs with `message.part.updated` type to see if `part.input`/`part.args` fields exist — if they do, filenames should appear in status text
6. If filename fields aren't present in events, the status still works (just shows labels without filenames)

- [ ] **Step 2: Commit**

```bash
git add web/src/components/ChatBar.tsx
git commit -m "fix: improve chatbar status labels for AI tool progress

Expand toolProgress map with more tool names, add filename
extraction from event data, and use 'working...' fallback
instead of cryptic tool names like 'task...'

Closes #2 (partial — status bar only, defers collapsible blocks
and generating-state icons)"
```
