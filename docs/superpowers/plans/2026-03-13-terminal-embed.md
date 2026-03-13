# OpenCode Terminal Embed — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed OpenCode's native TUI in the Oyster OS surface via xterm.js + a WebSocket PTY server, so users can talk to OpenCode directly from the browser.

**Architecture:** A small Node.js WebSocket server (`server/`) spawns `opencode` in a pseudo-terminal using `node-pty`. The frontend connects via xterm.js inside a draggable WindowChrome. The Oyster button in the chat bar opens/closes the terminal window.

**Tech Stack:** node-pty, ws (WebSocket), xterm.js, xterm-addon-fit, existing React 19 + Vite frontend

---

## File Structure

```
oyster-os/
├── server/                          # NEW — WebSocket PTY server
│   ├── package.json                 # node-pty, ws dependencies
│   └── src/
│       └── index.ts                 # WS server: spawns opencode in PTY, relays I/O
├── web/
│   ├── src/
│   │   ├── components/
│   │   │   └── TerminalWindow.tsx   # NEW — xterm.js inside WindowChrome
│   │   ├── stores/
│   │   │   └── windows.ts          # MODIFY — add "terminal" window type
│   │   ├── App.tsx                  # MODIFY — render TerminalWindow, wire Oyster button
│   │   └── App.css                  # MODIFY — add terminal styles
│   └── package.json                 # ADD xterm.js dependencies
```

---

## Chunk 1: WebSocket PTY Server

### Task 1: Server scaffold

**Files:**
- Create: `server/package.json`
- Create: `server/src/index.ts`
- Create: `server/tsconfig.json`

- [ ] **Step 1: Create server/package.json**

```json
{
  "name": "oyster-server",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts"
  },
  "dependencies": {
    "node-pty": "^1.0.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/ws": "^8.18.0",
    "tsx": "^4.19.0"
  }
}
```

- [ ] **Step 2: Create server/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `cd /Users/Matthew.Slight/Dev/oyster-os/server && npm install`

Expected: node_modules created, no errors. `node-pty` may require native compilation — if it fails, check that Xcode Command Line Tools are installed (`xcode-select --install`).

Also verify that `server/node_modules/` is covered by `.gitignore`. The root `.gitignore` should have `node_modules/` — if not, add it.

- [ ] **Step 4: Write the WebSocket PTY server**

`server/src/index.ts`:

```typescript
import { WebSocketServer, WebSocket } from "ws";
import pty from "node-pty";

const PORT = 4200;
const SHELL = "opencode";

const wss = new WebSocketServer({ port: PORT });
console.log(`PTY WebSocket server listening on ws://localhost:${PORT}`);

wss.on("connection", (ws: WebSocket) => {
  console.log("Client connected — spawning opencode");

  const proc = pty.spawn(SHELL, [], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: process.env.OYSTER_WORKSPACE || process.cwd(),
    env: { ...process.env } as Record<string, string>,
  });

  // PTY → client
  proc.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  proc.onExit(({ exitCode }) => {
    console.log(`opencode exited with code ${exitCode}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });

  // Client → PTY
  ws.on("message", (msg: Buffer | string) => {
    const data = typeof msg === "string" ? msg : msg.toString("utf-8");

    // Handle resize messages
    if (data.startsWith("\x01resize:")) {
      const parts = data.slice(8).split(",");
      const cols = parseInt(parts[0], 10);
      const rows = parseInt(parts[1], 10);
      if (cols > 0 && rows > 0) {
        proc.resize(cols, rows);
      }
      return;
    }

    proc.write(data);
  });

  ws.on("close", () => {
    console.log("Client disconnected — killing opencode");
    proc.kill();
  });
});
```

The resize protocol is simple: client sends `\x01resize:COLS,ROWS` as a control message. Everything else goes straight to the PTY.

- [ ] **Step 5: Test the server manually**

Run: `cd /Users/Matthew.Slight/Dev/oyster-os/server && npm run dev`

Expected: `PTY WebSocket server listening on ws://localhost:4200`

Then in another terminal, verify with websocat (optional):
```bash
# If websocat is installed:
websocat ws://localhost:4200
# Should see opencode TUI output
```

If websocat isn't installed, skip — we'll test via the frontend.

- [ ] **Step 6: Commit**

```bash
cd /Users/Matthew.Slight/Dev/oyster-os
git add server/
git commit -m "feat: WebSocket PTY server for opencode terminal"
```

---

## Chunk 2: Frontend Terminal Component

### Task 2: Install xterm.js

**Files:**
- Modify: `web/package.json`

- [ ] **Step 1: Install xterm.js and addons**

Run: `cd /Users/Matthew.Slight/Dev/oyster-os/web && npm install @xterm/xterm @xterm/addon-fit @xterm/addon-web-links`

Expected: packages added to `dependencies` in package.json.

---

### Task 3: TerminalWindow component

**Files:**
- Create: `web/src/components/TerminalWindow.tsx`

- [ ] **Step 1: Write TerminalWindow**

`web/src/components/TerminalWindow.tsx`:

```typescript
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { WindowChrome } from "./WindowChrome";

interface Props {
  defaultX: number;
  defaultY: number;
  zIndex: number;
  onMinimize: () => void;
  onClose: () => void;
}

const WS_URL = "ws://localhost:4200";

export function TerminalWindow({
  defaultX,
  defaultY,
  zIndex,
  onMinimize,
  onClose,
}: Props) {
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!termRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'IBM Plex Mono', monospace",
      theme: {
        background: "#1e1f36",
        foreground: "#e8e9f0",
        cursor: "#21b981",
        selectionBackground: "rgba(33, 185, 129, 0.3)",
        black: "#1a1b2e",
        brightBlack: "#555770",
        green: "#21b981",
        brightGreen: "#34d399",
        blue: "#6366f1",
        brightBlue: "#818cf8",
        yellow: "#f59e0b",
        brightYellow: "#fbbf24",
        red: "#ef4444",
        brightRed: "#f87171",
        magenta: "#a855f7",
        brightMagenta: "#c084fc",
        cyan: "#06b6d4",
        brightCyan: "#22d3ee",
        white: "#e8e9f0",
        brightWhite: "#ffffff",
      },
    });
    terminalRef.current = terminal;

    const fitAddon = new FitAddon();
    fitRef.current = fitAddon;
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());

    terminal.open(termRef.current);
    fitAddon.fit();

    // Connect to WebSocket PTY server
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      // Send initial size
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        ws.send(`\x01resize:${dims.cols},${dims.rows}`);
      }
    };

    ws.onmessage = (event) => {
      terminal.write(typeof event.data === "string" ? event.data : "");
    };

    ws.onclose = () => {
      terminal.write("\r\n\x1b[90m[connection closed]\x1b[0m\r\n");
    };

    ws.onerror = () => {
      terminal.write(
        "\r\n\x1b[31m[connection error — is the server running?]\x1b[0m\r\n"
      );
    };

    // Terminal input → WebSocket
    terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims && ws.readyState === WebSocket.OPEN) {
        ws.send(`\x01resize:${dims.cols},${dims.rows}`);
      }
    });
    resizeObserver.observe(termRef.current);

    return () => {
      resizeObserver.disconnect();
      ws.close();
      terminal.dispose();
    };
  }, []);

  return (
    <WindowChrome
      title="opencode"
      onMinimize={onMinimize}
      onClose={onClose}
      defaultX={defaultX}
      defaultY={defaultY}
      defaultW={720}
      defaultH={480}
      zIndex={zIndex}
    >
      <div
        ref={termRef}
        style={{ width: "100%", height: "100%", padding: "4px" }}
      />
    </WindowChrome>
  );
}
```

Key details:
- Theme colors match Oyster OS design tokens (dark blues, green accent)
- Uses `ResizeObserver` + `FitAddon` so the terminal adapts when the window moves
- Sends `\x01resize:` control messages matching the server protocol
- Shows connection errors inline in the terminal

---

### Task 4: Wire into window system

**Files:**
- Modify: `web/src/stores/windows.ts` — add `"terminal"` window type
- Modify: `web/src/App.tsx` — render TerminalWindow, change Oyster button behavior
- Modify: `web/src/App.css` — terminal-specific styles

- [ ] **Step 1: Update windows store**

In `web/src/stores/windows.ts`, add `"terminal"` to the WindowType and add an `OPEN_TERMINAL` action:

Change `WindowType`:
```typescript
export type WindowType = "chat" | "viewer" | "terminal";
```

Add to `WindowAction`:
```typescript
  | { type: "OPEN_TERMINAL" }
```

Add case to `windowsReducer` (singleton — only one terminal window, restores if minimized):
```typescript
    case "OPEN_TERMINAL": {
      const existing = state.find((w) => w.type === "terminal");
      if (existing) {
        return state.map((w) =>
          w.id === existing.id ? { ...w, minimized: false } : w
        );
      }
      return [
        ...state,
        {
          id: "terminal-" + nextId++,
          type: "terminal",
          title: "opencode",
          minimized: false,
          statusText: "",
        },
      ];
    }
```

- [ ] **Step 2: Update App.tsx**

In `web/src/App.tsx`:

Add import:
```typescript
import { TerminalWindow } from "./components/TerminalWindow";
```

Add terminal window filter alongside visibleViewers:
```typescript
  const terminalWindow = windows.find(
    (w) => w.type === "terminal" && !w.minimized
  );
```

Render TerminalWindow in the windows-layer, after the viewer map:
```typescript
        {terminalWindow && (
          <TerminalWindow
            key={terminalWindow.id}
            defaultX={120}
            defaultY={60}
            zIndex={150}
            onMinimize={() => dispatch({ type: "MINIMIZE", id: terminalWindow.id })}
            onClose={() => dispatch({ type: "CLOSE", id: terminalWindow.id })}
          />
        )}
```

Pass `dispatch` to ChatBar so the Oyster button can open the terminal:
```typescript
      <ChatBar
        onArtifactGenerated={handleArtifactGenerated}
        onOpenTerminal={() => dispatch({ type: "OPEN_TERMINAL" })}
      />
```

- [ ] **Step 3: Update ChatBar to accept onOpenTerminal**

In `web/src/components/ChatBar.tsx`:

Add to Props:
```typescript
interface Props {
  onArtifactGenerated: (artifact: Artifact) => void;
  onOpenTerminal: () => void;
}
```

Update the destructuring:
```typescript
export function ChatBar({ onArtifactGenerated, onOpenTerminal }: Props) {
```

Change the Oyster button click handler — long-press or double-click opens terminal, single click toggles chat:
```typescript
        <div
          className="chatbar-oyster"
          onClick={() => setExpanded(!expanded)}
          onDoubleClick={onOpenTerminal}
          title="Double-click to open terminal"
        >
```

- [ ] **Step 4: Add terminal CSS**

Append to `web/src/App.css`:

```css
/* ── Terminal ── */
.window-body .xterm {
  padding: 4px;
}

.window-body .xterm-viewport {
  overflow-y: auto;
}

.window-body .xterm-screen {
  width: 100%;
}
```

- [ ] **Step 5: Test end-to-end**

1. Start the WS server: `cd server && npm run dev`
2. Start the frontend: `cd web && npm run dev`
3. Open browser → double-click the Oyster button
4. Terminal window should appear with opencode TUI
5. Type in the terminal — should interact with opencode
6. Drag the window — should work via titlebar
7. Close the window — should disconnect WebSocket

- [ ] **Step 6: Commit**

```bash
cd /Users/Matthew.Slight/Dev/oyster-os
git add web/src/components/TerminalWindow.tsx web/src/stores/windows.ts web/src/App.tsx web/src/App.css web/src/components/ChatBar.tsx web/package.json web/package-lock.json
git commit -m "feat: embed opencode terminal in surface via xterm.js"
```

---

## Chunk 3: Dev experience polish

### Task 5: Concurrent dev script

**Files:**
- Create: `package.json` (project root)

- [ ] **Step 1: Create root package.json with dev script**

Create `/Users/Matthew.Slight/Dev/oyster-os/package.json`:

```json
{
  "name": "oyster-os",
  "private": true,
  "scripts": {
    "dev": "npx concurrently -n web,server -c blue,green \"cd web && npm run dev\" \"cd server && npm run dev\"",
    "dev:web": "cd web && npm run dev",
    "dev:server": "cd server && npm run dev"
  }
}
```

Note: No `workspaces` field — web/ and server/ keep independent `node_modules` to avoid dependency hoisting issues.

- [ ] **Step 2: Install concurrently**

Run: `cd /Users/Matthew.Slight/Dev/oyster-os && npm install -D concurrently`

- [ ] **Step 3: Test**

Run: `cd /Users/Matthew.Slight/Dev/oyster-os && npm run dev`

Expected: Both the Vite frontend and WS PTY server start together. Labeled output: `[web]` and `[server]`.

- [ ] **Step 4: Commit**

```bash
cd /Users/Matthew.Slight/Dev/oyster-os
git add package.json package-lock.json
git commit -m "feat: root workspace with concurrent dev script"
```

---

## Summary

| Task | What | Depends On |
|------|------|------------|
| 1 | WebSocket PTY server (server/) | — |
| 2 | Install xterm.js in frontend | — |
| 3 | TerminalWindow component | 2 |
| 4 | Wire into window system + ChatBar | 1, 3 |
| 5 | Root dev script (run both) | 1, 4 |

After this plan, you'll have OpenCode running in a browser terminal on the Oyster surface. The next step would be wiring Supabase so artifacts created by OpenCode appear as icons.
