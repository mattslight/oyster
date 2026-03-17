# Artifact Error Visibility Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture fatal JS errors inside artifact iframes, show a friendly error screen, and let users send the error to Oyster for auto-repair.

**Architecture:** The server inlines a bridge script into every artifact HTML response. The bridge captures `window.onerror` and `onunhandledrejection`, buffers recent console output, and `postMessage`s to the parent. `ViewerWindow` listens for these messages, unmounts the crashed iframe, shows an error screen with "Fix it" and "Retry" buttons.

**Tech Stack:** TypeScript, React (Vite), Node/Bun HTTP server, postMessage API

**Spec:** `docs/superpowers/specs/2026-03-14-artifact-error-visibility-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `server/src/error-bridge.ts` | **Create** — exports the bridge script as a string constant + `injectBridge(html)` function |
| `server/src/index.ts` | **Modify** — call `injectBridge()` when serving `.html` and `.md` artifact files |
| `web/src/components/ViewerWindow.tsx` | **Modify** — add error state, postMessage listener, error screen UI, Retry button |
| `web/src/App.tsx` | **Modify** — pass `onFixError` callback to ViewerWindow that sends error to chat |
| `web/src/App.css` | **Modify** — add error screen styles |

---

## Chunk 1: Bridge Script + Server Injection

### Task 1: Create the bridge script module

**Files:**
- Create: `server/src/error-bridge.ts`

- [ ] **Step 1: Create `server/src/error-bridge.ts`**

```typescript
// server/src/error-bridge.ts
// Exports the error bridge script and an injection function.

const BRIDGE_SCRIPT = `<script data-oyster-bridge>
(function() {
  if (window.__oysterBridge) return;
  window.__oysterBridge = true;

  var MAX_ENTRIES = 20;
  var MAX_CHARS = 500;
  var fired = false;
  var buffer = [];

  function safeStr(val) {
    if (val === undefined) return 'undefined';
    if (val === null) return 'null';
    try {
      var s = typeof val === 'string' ? val : JSON.stringify(val);
      return s && s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) + '...' : (s || String(val));
    } catch (e) {
      return String(val);
    }
  }

  function pushEntry(type, args) {
    var msg = Array.prototype.map.call(args, safeStr).join(' ');
    buffer.push({ type: type, message: msg, ts: Date.now() });
    if (buffer.length > MAX_ENTRIES) buffer.shift();
  }

  var origLog = console.log, origWarn = console.warn, origError = console.error;
  console.log = function() { pushEntry('log', arguments); origLog.apply(console, arguments); };
  console.warn = function() { pushEntry('warn', arguments); origWarn.apply(console, arguments); };
  console.error = function() { pushEntry('error', arguments); origError.apply(console, arguments); };

  function sendError(message, stack) {
    if (fired) return;
    fired = true;
    var payload = JSON.stringify(buffer);
    if (payload.length > 5120) {
      buffer = buffer.slice(-10);
      payload = JSON.stringify(buffer);
    }
    try {
      window.parent.postMessage({
        type: 'oyster-error',
        artifactPath: window.location.pathname,
        error: { message: String(message), stack: String(stack || '') },
        console: buffer
      }, window.location.origin);
    } catch (e) {}
  }

  window.onerror = function(msg, src, line, col, err) {
    sendError(msg, err && err.stack ? err.stack : src + ':' + line + ':' + col);
  };

  window.onunhandledrejection = function(e) {
    var reason = e.reason;
    if (reason instanceof Error) {
      sendError(reason.message, reason.stack);
    } else {
      sendError(String(reason), '');
    }
  };
})();
</script>`;

/**
 * Inject the error bridge script into an HTML string.
 * Injection order: after <head>, after <html>, after <!doctype>, or prepend.
 */
export function injectBridge(html: string): string {
  // After <head> (case-insensitive)
  const headMatch = html.match(/<head(\s[^>]*)?>/i);
  if (headMatch) {
    const idx = headMatch.index! + headMatch[0].length;
    return html.slice(0, idx) + BRIDGE_SCRIPT + html.slice(idx);
  }

  // After <html>
  const htmlMatch = html.match(/<html(\s[^>]*)?>/i);
  if (htmlMatch) {
    const idx = htmlMatch.index! + htmlMatch[0].length;
    return html.slice(0, idx) + BRIDGE_SCRIPT + html.slice(idx);
  }

  // After <!doctype>
  const doctypeMatch = html.match(/<!doctype\s[^>]*>/i);
  if (doctypeMatch) {
    const idx = doctypeMatch.index! + doctypeMatch[0].length;
    return html.slice(0, idx) + BRIDGE_SCRIPT + html.slice(idx);
  }

  // Bare fragment — prepend
  return BRIDGE_SCRIPT + html;
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd /Users/Matthew.Slight/Dev/oyster-os/server && npx tsc --noEmit src/error-bridge.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/src/error-bridge.ts
git commit -m "feat: add error bridge script module for artifact error capture"
```

---

### Task 2: Inject bridge into artifact HTML responses

**Files:**
- Modify: `server/src/index.ts:722-772` (artifact serving section)

- [ ] **Step 1: Add import at top of `server/src/index.ts`**

Add after the existing imports:

```typescript
import { injectBridge } from "./error-bridge";
```

- [ ] **Step 2: Modify HTML file serving (line 767-769)**

Replace the `else` block that serves non-markdown files:

```typescript
    } else {
      res.writeHead(200, { "Content-Type": mime });
      res.end(readFileSync(filePath));
    }
```

With:

```typescript
    } else if (ext === ".html" || ext === ".htm") {
      const raw = readFileSync(filePath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(injectBridge(raw));
    } else {
      res.writeHead(200, { "Content-Type": mime });
      res.end(readFileSync(filePath));
    }
```

- [ ] **Step 3: Inject bridge into markdown-rendered HTML too**

In the markdown rendering section (around line 764), the server constructs HTML with a template literal. The bridge should be injected after `<head>`. Change:

```typescript
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${name}</title><style>
```

To:

```typescript
      const html = `<!DOCTYPE html><html><head>${BRIDGE_SCRIPT_TAG}<meta charset="utf-8"><title>${name}</title><style>
```

Wait — the bridge script is inside `error-bridge.ts` as a private constant. We need to export it or use `injectBridge` on the final HTML. The cleanest approach: call `injectBridge()` on the finished markdown HTML string.

Change the markdown section from:

```typescript
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
```

To:

```typescript
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(injectBridge(html));
```

- [ ] **Step 4: Test manually — create a broken artifact**

Create a test artifact with a JS error:

```bash
mkdir -p /Users/Matthew.Slight/Dev/oyster-os/artifacts/error-test/src
```

Write `artifacts/error-test/manifest.json`:
```json
{
  "id": "error-test",
  "name": "Error Test",
  "type": "app",
  "runtime": "static",
  "entrypoint": "src/index.html",
  "ports": [],
  "storage": "none",
  "capabilities": [],
  "status": "ready",
  "created_at": "2026-03-14T10:00:00Z",
  "updated_at": "2026-03-14T10:00:00Z"
}
```

Write `artifacts/error-test/src/index.html`:
```html
<!DOCTYPE html>
<html>
<head><title>Error Test</title></head>
<body>
  <h1>Error Test</h1>
  <script>
    console.log("Loading...");
    console.warn("About to crash");
    // This will throw a ReferenceError
    nonExistentFunction();
  </script>
</body>
</html>
```

- [ ] **Step 5: Verify bridge injection**

Open the artifact URL in a browser (or curl it) and check that the `<script data-oyster-bridge>` tag appears immediately after `<head>`:

```bash
curl -s http://localhost:4200/artifacts/error-test/src/index.html | head -5
```

Expected: Second line should contain `<script data-oyster-bridge>`

- [ ] **Step 6: Verify postMessage fires in browser console**

Open the artifact directly in a browser tab. Open DevTools console. You should see:
- `Loading...` (console.log)
- `About to crash` (console.warn)
- The ReferenceError

Then in the parent page's console (if in an iframe), verify the postMessage was sent. For now just confirm the bridge script is present and runs without its own errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/index.ts
git commit -m "feat: inject error bridge into artifact HTML responses"
```

---

## Chunk 2: ViewerWindow Error Screen + Fix-it Integration

### Task 3: Add error state and postMessage listener to ViewerWindow

**Files:**
- Modify: `web/src/components/ViewerWindow.tsx`

- [ ] **Step 1: Add state and types**

Add imports at the top:

```typescript
import { useState, useEffect, useRef, useMemo, useCallback, type PointerEvent as ReactPointerEvent } from "react";
```

Add the type **above** the component function (not inside it):

```typescript
interface ArtifactError {
  message: string;
  stack: string;
  console: Array<{ type: string; message: string; ts: number }>;
}
```

Add to the component body (after `const iframeSrc = ...`):

```typescript
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<ArtifactError | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
```

- [ ] **Step 2: Add postMessage listener**

Add a `useEffect` after the existing callbacks:

```typescript
  // Listen for error bridge messages from the artifact iframe
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type !== "oyster-error") return;

      setError({
        message: event.data.error?.message || "Unknown error",
        stack: event.data.error?.stack || "",
        console: Array.isArray(event.data.console) ? event.data.console : [],
      });
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);
```

- [ ] **Step 3: Clear error on path change**

Add a `useEffect` to reset error when path changes:

```typescript
  useEffect(() => {
    setError(null);
    setIframeKey((k) => k + 1);
  }, [path]);
```

- [ ] **Step 4: Add Retry handler**

```typescript
  const handleRetry = useCallback(() => {
    setError(null);
    setIframeKey((k) => k + 1);
  }, []);
```

- [ ] **Step 5: Update the `onFixError` prop**

Add to the `Props` interface **and** to the destructured props in the function signature (line 19-32):

```typescript
// In Props interface:
  onFixError?: (error: { title: string; message: string; stack: string; console: Array<{ type: string; message: string }> }) => void;

// In function signature — add onFixError to the destructured params:
// export function ViewerWindow({ title, path, ..., onFixError, ...}: Props) {
```

- [ ] **Step 6: Render error screen or iframe**

Replace the existing `<iframe>` tag (line 135-139):

```tsx
      <iframe
        src={iframeSrc}
        className="viewer-iframe"
        title={title}
      />
```

With:

```tsx
      {error ? (
        <div className="viewer-error-screen">
          <div className="viewer-error-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" fill="#3a1e1e" />
              <path d="M12 8v4m0 4h.01" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          <h3 className="viewer-error-title">This app ran into a problem</h3>
          <p className="viewer-error-message">{error.message}</p>
          <div className="viewer-error-actions">
            {onFixError && (
              <button
                className="viewer-error-fix"
                onClick={() => onFixError({ title, message: error.message, stack: error.stack, console: error.console })}
              >
                Ask Oyster to fix it
              </button>
            )}
            <button className="viewer-error-retry" onClick={handleRetry}>
              Retry
            </button>
          </div>
          <ErrorDetails stack={error.stack} consoleEntries={error.console} />
        </div>
      ) : (
        <iframe
          key={iframeKey}
          ref={iframeRef}
          src={iframeSrc}
          className="viewer-iframe"
          title={title}
        />
      )}
```

- [ ] **Step 7: Add ErrorDetails sub-component**

Add above the `ViewerWindow` component in the same file:

```typescript
function ErrorDetails({ stack, consoleEntries }: { stack: string; consoleEntries: Array<{ type: string; message: string }> }) {
  const [open, setOpen] = useState(false);
  if (!stack && consoleEntries.length === 0) return null;

  return (
    <div className="viewer-error-details">
      <button className="viewer-error-details-toggle" onClick={() => setOpen(!open)}>
        {open ? "Hide details" : "Show details"}
      </button>
      {open && (
        <pre className="viewer-error-stack">
          {stack}
          {consoleEntries.length > 0 && (
            "\n\nConsole:\n" + consoleEntries.map((e) => `[${e.type}] ${e.message}`).join("\n")
          )}
        </pre>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Commit**

```bash
git add web/src/components/ViewerWindow.tsx
git commit -m "feat: add error screen and postMessage listener to ViewerWindow"
```

---

### Task 4: Add error screen CSS

**Files:**
- Modify: `web/src/App.css`

- [ ] **Step 1: Add error screen styles**

Append to the end of `web/src/App.css`:

```css
/* ── Artifact error screen ── */
.viewer-error-screen {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: #1a1a2e;
  padding: 32px;
  text-align: center;
}

.viewer-error-icon {
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.viewer-error-title {
  color: #e2e8f0;
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}

.viewer-error-message {
  color: #64748b;
  font-size: 13px;
  max-width: 300px;
  margin: 0;
}

.viewer-error-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.viewer-error-fix {
  background: #7c3aed;
  color: white;
  border: none;
  padding: 8px 18px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
}

.viewer-error-fix:hover {
  background: #6d28d9;
}

.viewer-error-retry {
  background: #2a2a3e;
  color: #94a3b8;
  border: 1px solid #3a3a5e;
  padding: 8px 14px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
}

.viewer-error-retry:hover {
  background: #333350;
}

.viewer-error-details {
  margin-top: 4px;
}

.viewer-error-details-toggle {
  background: none;
  border: none;
  color: #64748b;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
  font-family: inherit;
}

.viewer-error-stack {
  text-align: left;
  background: rgba(255, 255, 255, 0.04);
  padding: 12px;
  border-radius: 6px;
  color: #94a3b8;
  font-size: 11px;
  font-family: "IBM Plex Mono", monospace;
  max-height: 200px;
  overflow: auto;
  margin: 8px 0 0;
  white-space: pre-wrap;
  word-break: break-all;
  max-width: 500px;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/App.css
git commit -m "feat: add error screen CSS styles"
```

---

### Task 5: Wire up "Fix it" from App.tsx

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Import `getOrCreateSession` and `sendMessage`**

Add to the imports in `App.tsx`:

```typescript
import { getOrCreateSession, sendMessage } from "./data/chat-api";
```

- [ ] **Step 2: Create the `handleFixError` callback**

Add inside the `App` component, after `handleArtifactStop`:

```typescript
  async function handleFixError(error: { title: string; message: string; stack: string; console: Array<{ type: string; message: string }> }) {
    try {
      const sessionId = await getOrCreateSession();
      const consoleText = error.console.length > 0
        ? "\n\nRecent console output:\n" + error.console.map((e) => `[${e.type}] ${e.message}`).join("\n")
        : "";
      const message = `The artifact "${error.title}" crashed with an error:\n\n${error.stack || error.message}${consoleText}\n\nPlease fix this error in the artifact source code.`;
      await sendMessage(sessionId, message);
    } catch (err) {
      console.error("Failed to send fix-it message:", err);
    }
  }
```

- [ ] **Step 3: Pass `onFixError` to ViewerWindow**

In the `viewers.map(...)` JSX (around line 122), add the prop to `<ViewerWindow>`:

```tsx
              <ViewerWindow
                key={w.id}
                title={w.title}
                path={w.artifactPath!}
                defaultX={200 + i * 20}
                defaultY={40 + i * 20}
                zIndex={w.zIndex}
                fullscreen={w.fullscreen}
                onFocus={() => dispatch({ type: "FOCUS", id: w.id })}
                onClose={() => dispatch({ type: "CLOSE", id: w.id })}
                onToggleFullscreen={() => dispatch({ type: "TOGGLE_FULLSCREEN", id: w.id })}
                hasPrev={hasPrev}
                hasNext={hasNext}
                onFixError={handleFixError}
                onNavigate={(dir) => {
```

- [ ] **Step 4: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat: wire Fix-it button to send error context to Oyster chat"
```

---

### Task 6: End-to-end manual test

- [ ] **Step 1: Restart the server**

The server should pick up the changes automatically (or restart it manually).

- [ ] **Step 2: Open the Oyster OS desktop in the browser**

Navigate to the Oyster OS URL. The "Error Test" artifact should appear on the desktop.

- [ ] **Step 3: Click the Error Test artifact**

It should open in a ViewerWindow. Since the artifact has a `nonExistentFunction()` call, you should see:
- The error screen with "This app ran into a problem"
- The message "nonExistentFunction is not defined" (or similar)
- "Ask Oyster to fix it" button
- "Retry" button
- "Show details" link

- [ ] **Step 4: Click "Show details"**

Should expand to show the stack trace and console output:
```
[log] Loading...
[warn] About to crash
```

- [ ] **Step 5: Click "Ask Oyster to fix it"**

Should send the error message to the chatbar. You should see Oyster start processing in the chat status bar.

- [ ] **Step 6: Click "Retry" after fix**

After Oyster fixes the artifact, click "Retry". The error screen should disappear and the fixed artifact should load.

- [ ] **Step 7: Verify clean artifacts are unaffected**

Open a working artifact (e.g. Zombie Horde). It should load normally with no error screen.

- [ ] **Step 8: Clean up test artifact**

```bash
rm -rf /Users/Matthew.Slight/Dev/oyster-os/artifacts/error-test
```

- [ ] **Step 9: Final commit**

```bash
git add -A
git commit -m "feat: artifact error visibility and auto-fix (#1)"
```

---

## Chunk 3: GitHub Issue Cleanup

### Task 7: Update GitHub issues

- [ ] **Step 1: Narrow issue #1 scope**

Update issue #1 body to only cover acceptance criteria A and B. Remove C and E from the checklist (they'll be separate issues).

- [ ] **Step 2: Create follow-up issues for deferred criteria**

Create issue for "Artifact loading state" (acceptance criteria C) and "Artifact 404/network failure fallback" (acceptance criteria E). Add them to the project board.

- [ ] **Step 3: Close issue #1**

After testing confirms everything works, close issue #1 and set its project board status to "Done".
