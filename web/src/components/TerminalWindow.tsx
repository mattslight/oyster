import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { WindowChrome } from "./WindowChrome";
import { ConfirmModal } from "./ConfirmModal";

interface Props {
  defaultX: number;
  defaultY: number;
  zIndex: number;
  onFocus?: () => void;
  onClose: () => void;
  /** When set, connect to /ws/terminal?id=<terminalId> (Claude PTY).
   *  When absent, connect to the legacy root path (OpenCode singleton). */
  terminalId?: string;
  /** Title shown in the window chrome. Defaults to "opencode" for legacy
   *  shells. */
  title?: string;
  /** When non-null, render the title as a button that opens the inspector
   *  for this session. */
  linkedSessionId?: string;
  /** Optional callback fired when the user clicks a linked title. */
  onOpenSession?: (sessionId: string) => void;
  /** True when the underlying PTY is alive on the server. Controls whether
   *  the close button means "minimise" (alive — glyph −) or "close" (dead,
   *  PTY was stopped or exited — glyph ×). Defaults to true. */
  ptyAlive?: boolean;
  /** Optional handler to kill the PTY. When provided AND `ptyAlive`, a Stop
   *  (■) button is rendered in the header. Mirrors the popover Stop. */
  onStop?: () => void | Promise<void>;
  /** Whether this terminal is currently fullscreen. Lifted to the parent so
   *  the fullscreen tab bar can switch between sibling terminals. */
  fullscreen?: boolean;
  /** Toggle fullscreen for this terminal. Called by the green Expand dot
   *  in the title bar and by the toolbar's exit button. */
  onToggleFullscreen?: () => void;
  /** All currently-open terminals (this one included), used to render
   *  tabs in the fullscreen toolbar. Each entry is one tab. */
  liveTerminals?: Array<{ id: string; title: string }>;
  /** This window's id, used by the tabs to highlight the active one. */
  id?: string;
  /** Tab-click handler — switches the fullscreen view to another terminal
   *  without leaving fullscreen mode. */
  onSwitchTerminal?: (id: string) => void;
}

export function TerminalWindow({
  defaultX,
  defaultY,
  zIndex,
  onFocus,
  onClose,
  terminalId,
  title,
  linkedSessionId,
  onOpenSession,
  ptyAlive = true,
  onStop,
  fullscreen = false,
  onToggleFullscreen,
  liveTerminals,
  id,
  onSwitchTerminal,
}: Props) {
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);

  // Stop button click — same fork in behaviour as the popover's Stop
  // button (shared localStorage flag, so the user only needs to ack once
  // across both surfaces).
  function requestStop() {
    if (!onStop) return;
    if (localStorage.getItem("oyster-skip-stop-confirm") === "1") {
      void onStop();
    } else {
      setDontAskAgain(false);
      setStopConfirmOpen(true);
    }
  }
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const wsUrl = useMemo(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const host = window.location.host;
    if (terminalId) {
      return `${proto}://${host}/ws/terminal?id=${encodeURIComponent(terminalId)}`;
    }
    // Legacy singleton — root path.
    return `${proto}://${host}`;
  }, [terminalId]);

  const isClaudeTerm = !!terminalId;

  useEffect(() => {
    if (!termRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'MesloLGM Nerd Font', 'MesloLGM Nerd Font Mono', 'MesloLGS NF', Menlo, 'SF Mono', 'IBM Plex Mono', monospace",
      theme: {
        background: "#0a0c12",
        foreground: "#cfe3e1",
        cursor: "#5eead4",
        selectionBackground: "rgba(94, 234, 212, 0.25)",
        black: "#0a0c12",
        brightBlack: "#555770",
        green: "#5eead4",
        brightGreen: "#7ff0d8",
        blue: "#8b9bff",
        brightBlue: "#a5b4fc",
        yellow: "#febc2e",
        brightYellow: "#fbd24a",
        red: "#ff5f57",
        brightRed: "#ff8278",
        magenta: "#c4b5fd",
        brightMagenta: "#d8caff",
        cyan: "#5eead4",
        brightCyan: "#a4f4e3",
        white: "#cfe3e1",
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

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    const sendResize = (cols: number, rows: number): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (isClaudeTerm) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      } else {
        ws.send(`\x01resize:${cols},${rows}`);
      }
    };

    ws.onopen = () => {
      const dims = fitAddon.proposeDimensions();
      if (dims) sendResize(dims.cols, dims.rows);
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

    terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims) sendResize(dims.cols, dims.rows);
    });
    resizeObserver.observe(termRef.current);

    return () => {
      resizeObserver.disconnect();
      ws.close();
      terminal.dispose();
    };
  }, [wsUrl, isClaudeTerm]);

  const titleNode: React.ReactNode = linkedSessionId && onOpenSession ? (
    <button
      type="button"
      onClick={() => onOpenSession(linkedSessionId)}
      style={{
        background: "none",
        border: "none",
        color: "inherit",
        font: "inherit",
        cursor: "pointer",
        textDecoration: "underline",
        padding: 0,
      }}
      title="Open in Session Inspector"
    >
      {title ?? "claude"}
    </button>
  ) : (title ?? "opencode");

  return (
    <>
      <WindowChrome
        title={titleNode}
        variant="terminal"
        onFocus={onFocus}
        onClose={onClose}
        defaultX={defaultX}
        defaultY={defaultY}
        defaultW={720}
        defaultH={480}
        zIndex={zIndex}
        fullscreen={fullscreen}
        onToggleFullscreen={onToggleFullscreen}
        closeButtonTooltip={ptyAlive ? "Minimise terminal" : "Close window"}
        closeButtonGlyph={ptyAlive ? "−" : "×"}
        closeButtonColor={ptyAlive ? "amber" : "red"}
        extraHeader={ptyAlive && onStop ? (
          <button
            type="button"
            className="window-btn window-btn--stop"
            onClick={requestStop}
            title="Stop terminal"
            aria-label="Stop terminal"
          >■</button>
        ) : undefined}
      >
        {fullscreen && liveTerminals && liveTerminals.length > 0 && (
          <div className="terminal-fs-tabs">
            <div className="terminal-fs-tabs-list">
              {liveTerminals.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`terminal-fs-tab${t.id === id ? " is-active" : ""}`}
                  onClick={() => {
                    if (t.id === id) return;
                    onSwitchTerminal?.(t.id);
                  }}
                  title={t.title}
                >
                  <span className="terminal-fs-tab-dot" />
                  <span className="terminal-fs-tab-label">{t.title}</span>
                </button>
              ))}
            </div>
            {onToggleFullscreen && (
              <button
                type="button"
                className="terminal-fs-tabs-exit"
                onClick={onToggleFullscreen}
                title="Exit fullscreen"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              </button>
            )}
          </div>
        )}
        <div
          ref={termRef}
          style={{ width: "100%", flex: 1, minHeight: 0, padding: "4px" }}
        />
      </WindowChrome>
      <ConfirmModal
        open={stopConfirmOpen}
        title="Stop this terminal?"
        body={
          <>
            <p>Ending the session kills the Claude process and discards any in-progress work. The conversation history stays in the Sessions list.</p>
            <label className="rtp-confirm-checkbox">
              <input type="checkbox" checked={dontAskAgain} onChange={(e) => setDontAskAgain(e.target.checked)} />
              Don't ask me again
            </label>
          </>
        }
        confirmLabel="Stop terminal"
        cancelLabel="Cancel"
        destructive
        onCancel={() => setStopConfirmOpen(false)}
        onConfirm={() => {
          if (dontAskAgain) localStorage.setItem("oyster-skip-stop-confirm", "1");
          setStopConfirmOpen(false);
          void onStop?.();
        }}
      />
    </>
  );
}
