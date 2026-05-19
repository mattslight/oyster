import { useEffect, useMemo, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { WindowChrome } from "./WindowChrome";

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
}: Props) {
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
      fontFamily: "'IBM Plex Mono', monospace",
      theme: {
        background: "#1e1f36",
        foreground: "#e8e9f0",
        cursor: "#7c6bff",
        selectionBackground: "rgba(124, 107, 255, 0.3)",
        black: "#1a1b2e",
        brightBlack: "#555770",
        green: "#7c6bff",
        brightGreen: "#a597ff",
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
    <WindowChrome
      title={titleNode}
      onFocus={onFocus}
      onClose={onClose}
      defaultX={defaultX}
      defaultY={defaultY}
      defaultW={720}
      defaultH={480}
      zIndex={zIndex}
      closeButtonTooltip="Minimise terminal"
      closeButtonGlyph="−"
    >
      <div
        ref={termRef}
        style={{ width: "100%", height: "100%", padding: "4px" }}
      />
    </WindowChrome>
  );
}
