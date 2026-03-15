# Artifact Error Visibility & Debugging — Design Spec

**Issue:** [#1](https://github.com/mattslight/oyster-os/issues/1)
**Date:** 2026-03-14

## Problem

When AI-generated artifacts have runtime JS errors, users see a blank iframe with zero feedback. Technical users must open DevTools to find the issue. Non-technical users (e.g. a kid building a game) hit a dead end.

## Goal

Capture fatal JS errors inside artifact iframes, show a friendly error screen, and let the user send the error to Oyster for auto-repair — all without opening DevTools.

## Scope

**In scope (this spec):**
- Runtime JS error capture inside artifact iframes (acceptance criteria A)
- "Fix it" action that sends error context to the AI chat (acceptance criteria B)

**Deferred (split into follow-up issues):**
- Loading state while artifact initializes (acceptance criteria C)
- 404 / network failure fallback UI (acceptance criteria E)

Issue #1 scope should be narrowed to A and B only. C and E get their own issues.

## Design

### Architecture: Server-side bridge injection (Approach 1)

The server injects a small error-capture script into every artifact HTML response at serve-time. This is invisible to the user and the AI agent, works retroactively for all existing artifacts, and keeps the bridge in one maintainable place.

Rejected alternatives:
- **srcdoc wrapping** — breaks relative asset paths, fragile string manipulation
- **Companion script in artifacts** — relies on AI agent always including it, existing artifacts uncovered

### Data Flow

```
Artifact iframe (same-origin)
  │  injected bridge script:
  │  - patches window.onerror + onunhandledrejection
  │  - buffers last 20 console entries
  │  - on fatal error: postMessage to parent
  ▼
ViewerWindow (parent)
  │  message listener validates origin + source + type
  │  sets error state → unmounts iframe, shows error screen
  │  user clicks "Fix it"
  ▼
Chat API (existing)
  │  sendMessage() with formatted error + console buffer
  │  Oyster fixes artifact → user clicks "Retry" to reload
```

### Component 1: Bridge Script

**Delivery:** Inlined directly into artifact HTML by the server (no external file, no extra HTTP request, no new route needed)

Responsibilities:
- Monkey-patch `console.log`, `console.warn`, `console.error` to buffer recent entries (last 20, each with type + message + timestamp). Each entry is safely stringified: max 500 chars per entry, total payload capped at 5KB, circular references and non-serialisable values dropped gracefully.
- Listen for `window.onerror` and `window.onunhandledrejection` (handle the case where `reason` is not an `Error` object — stringify it)
- On fatal error, post to parent with explicit origin (same-origin iframes):
  ```js
  window.parent.postMessage({
    type: "oyster-error",
    artifactPath: window.location.pathname,
    error: { message: string, stack: string },
    console: [{ type: "log"|"warn"|"error", message: string, ts: number }, ...]
  }, window.location.origin)
  ```
- One-shot: after first fatal error, stop listening (prevent cascading error spam)
- Original console methods still work (patching is transparent)

### Component 2: Server Injection

**File:** `server/src/index.ts` (modify existing artifact serving)

When serving `.html` files from `/artefacts/*`:
- Read the response body
- Inline the bridge script as a `<script>` block immediately after `<head>` (to run before any artifact scripts in the head). Fallback order: after `<html>`, after `<!doctype>`, or **prepend** to the file if it's a bare HTML fragment. The bridge must run as early as possible to catch boot-time errors.
- Return modified response
- Skip non-HTML files (CSS, JS, images, etc.)

### Component 3: ViewerWindow Error State

**File:** `web/src/components/ViewerWindow.tsx` (modify existing)

New state:
- `error: null | { message: string, stack: string, console: ConsoleEntry[] }`

Behaviour:
- Add `message` event listener on mount, validate both `event.origin === window.location.origin` **and** `event.source === iframeRef.current?.contentWindow` (prevents cross-talk if multiple same-origin frames exist), then check `event.data.type === "oyster-error"`
- When error is set: **unmount the iframe entirely** (not just `display: none`) to stop any running timers, intervals, or animation loops. Remount with a fresh cache-bust key on Retry.
- Error screen design (full replacement, mockup B):
  - Warning icon + "This app hit an error"
  - Human-readable error message (e.g. "zombies is not defined")
  - "Ask Oyster to fix it" button (primary, prominent)
  - "Show details" button (secondary) — toggles stack trace display, collapsed by default
  - Stack trace shown in monospace, scrollable, for developers
- Error clears when: (a) artifact path changes (remounts iframe), or (b) user clicks a "Retry" button on the error screen (remounts iframe with a fresh cache-bust key). No automatic reload after Oyster fixes the file — the error screen stays until the user explicitly retries, avoiding jumpy silent refreshes.

### Component 4: Chat Integration

**File:** `web/src/components/ViewerWindow.tsx` (or thin helper)

`ViewerWindow` receives an `onFixError` callback prop from `App.tsx`. `App.tsx` implements this callback using the chat session ID it already manages (via `getOrCreateSession`), calling `sendMessage()` from `chat-api.ts`. This keeps chat logic centralised — `ViewerWindow` doesn't need to know about sessions.

The `{name}` in the message template maps to the `title` prop already passed to `ViewerWindow`.

Formatted message:

```
The artifact "{name}" crashed with an error:

{stack trace}

Recent console output:
{last 20 console entries, formatted as [type] message}

Please fix this error in the artifact source code.
```

This uses the existing chat session — no new API endpoints needed.

### Error Screen Visual Design

The error screen replaces the iframe content area within the existing WindowChrome:

- Dark background matching Oyster OS theme (`#1a1a2e`)
- Centred layout with warning icon in a red-tinted circle
- Title: "This app ran into a problem" (white, 14px, semi-bold)
- Subtitle: the error message in plain English (slate grey, 12px)
- Primary button: "Ask Oyster to fix it" (purple `#7c3aed`, white text)
- Secondary button: "Retry" (dark background, slate border) — remounts the iframe
- Tertiary button: "Show details" (text-only, slate) — toggles stack trace
- Expanded details: monospace stack trace, scrollable, slate text on dark background

Designed to be non-scary for a kid building a game, while giving developers access to the full trace on demand.

### Future Considerations

- **CSP:** If Content Security Policy headers are introduced later, inline script injection will need revisiting (e.g. nonce-based injection or an external script with a served route).

## Files Changed

| File | Change |
|------|--------|
| `server/src/index.ts` | Modify — inline bridge script into artifact HTML responses |
| `web/src/App.tsx` | Modify — pass `onFixError` callback to ViewerWindow |
| `web/src/components/ViewerWindow.tsx` | Modify — add error state, error screen UI, "Fix it" integration |

## Testing

- Create an artifact with a deliberate JS error → verify error screen appears
- Click "Fix it" → verify message appears in chat with correct error + console context
- Fix the artifact → verify error screen clears on refresh
- Verify non-erroring artifacts are unaffected
- Verify non-HTML artifact files (CSS, images) are not modified by injection
- Verify console buffering doesn't leak memory (capped at 20 entries)
- Test with multiple errors — only first should trigger the screen (one-shot)
